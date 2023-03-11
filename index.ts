import axios from "/opt/nodejs/node_modules/axios/index.js";
import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommandOutput,
  Instance as EC2Instance,
} from "@aws-sdk/client-ec2";
import {
  LightsailClient,
  GetInstancesCommand,
  StartInstanceCommand,
  StopInstanceCommand,
  GetInstancesCommandOutput,
  Instance as LightsailInstance,
} from "@aws-sdk/client-lightsail";
import { ApiHoliday, AWSLambdaEvent, EventSchedule, ResultItem } from "./types";

// UTC←→JST変換用の時間
const JST_TZ_OFFSET = 9;
// 祝日設定の選択値
const CANCEL_EVENT_ON_PUBLIC_HOLIDAY = 1;
// Dateオブジェクトの曜日フォーマッタ
const japaneseWeekday = new Intl.DateTimeFormat("ja-JP", {
  weekday: "long",
  timeZone: process.env.TZ,
});

const ec2 = new EC2Client({
  region: process.env.AWS_DEFAULT_REGION,
});
const lightsail = new LightsailClient({
  region: process.env.AWS_DEFAULT_REGION,
});

/**
 * メインの関数
 * @param event
 * @returns
 */
export const handler = async (event: AWSLambdaEvent) => {
  const currentDate = new Date();
  currentDate.setHours(currentDate.getHours() + JST_TZ_OFFSET, currentDate.getMinutes(), 0, 0);
  const currentDateStr =
    currentDate.getFullYear().toString() +
    "-" +
    String(currentDate.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(currentDate.getDate()).padStart(2, "0");

  // 現在日の年を元に祝日をAPIから取得
  const apiHolidayUrl = "https://holidays-jp.github.io/api/v1/" + currentDate.getFullYear().toString() + "/date.json";
  const fetchHolidays = async (): Promise<ApiHoliday> => {
    const response = await axios.get<ApiHoliday>(apiHolidayUrl);
    return response.data;
  };
  const holidays = await fetchHolidays();

  // 今日が祝日かどうか
  const todayIsHoliday = Object.keys(holidays).includes(currentDateStr);

  // EC2から一覧情報を取得
  const ec2Result = await ec2.send(new DescribeInstancesCommand({}));

  // Lightsailから一覧情報を取得
  const lightsailResult = await lightsail.send(new GetInstancesCommand({}));

  const results = event.schedules.map((schedule) => {
    // 入力のjson内に記載された時間と分をセットし関数実行時の現在時刻との差を計算
    // 現在時刻と比較し5分以内でないときイベント実施対象外としてスキップ
    const eventDate = new Date();
    eventDate.setHours(schedule.eventHour + JST_TZ_OFFSET, schedule.eventMinute, 0, 0);
    const diffSecond = (currentDate.getTime() - eventDate.getTime()) / 1000;
    if (diffSecond < 0 || 300 < diffSecond) {
      return createResultItem(schedule, "対象時間外のため何もしませんでした");
    }

    // 曜日チェック
    if (!schedule.weekdays.includes(currentDate.getDay())) {
      return createResultItem(schedule, `本日は${japaneseWeekday.format(currentDate)}のため何もしませんでした`);
    }

    // 今日が祝日かつ、「祝日のときイベントをキャンセルする」にチェックが入っているときの早期リターン
    if (todayIsHoliday && schedule.holiday === CANCEL_EVENT_ON_PUBLIC_HOLIDAY) {
      return createResultItem(schedule, `本日は祝日(${holidays[currentDateStr]})のため何もしませんでした`);
    }

    const resourceEventType = schedule.resourceType + schedule.eventType;
    switch (resourceEventType) {
      case "ec2start":
        return startEc2Instance(schedule, ec2Result);
      case "ec2stop":
        return stopEc2Instance(schedule, ec2Result);
      case "lightsailstart":
        return startLightsailInstance(schedule, lightsailResult);
      case "lightsailstop":
        return stopLightsailInstance(schedule, lightsailResult);
    }

    return createResultItem(schedule, "設定が正しくない可能性があります");
  });

  // 結果をログ出力
  // ※マネジメントコンソールやserverless invoke localから実行したときは戻り値の値が表示できる
  // 　しかし運用時のEventBridgeから実行した場合、consoleを使用して出力したものしか残らないのでここで明示的にログ出力する
  console.log(results);

  return {
    status: "success",
  };
};

/**
 * EC2インスタンスの一覧情報から操作対象のインスタンスを取得
 * @param resourceId
 * @param ec2Result
 * @returns
 */
const searchEc2Instance = (
  resourceId: string,
  ec2Result: DescribeInstancesCommandOutput
): EC2Instance | undefined => {
  return ec2Result?.Reservations?.flatMap((reservation) => reservation.Instances || []).find(
    (instance) => instance?.InstanceId === resourceId
  );
};

/**
 * Lightsailインスタンスの一覧情報から操作対象のインスタンスを取得
 * @param resourceId
 * @param lightsailResult
 * @returns
 */
const searchLightsailInstance = (
  resourceId: string,
  lightsailResult: GetInstancesCommandOutput
): LightsailInstance | undefined => {
  return lightsailResult?.instances?.find((instance) => {
    return instance.resourceType === "Instance" && instance.name === resourceId;
  });
};

/**
 * EC2インスタンスを起動
 * @param schedule
 * @param ec2Result
 * @returns
 */
const startEc2Instance = (schedule: EventSchedule, ec2Result: DescribeInstancesCommandOutput): ResultItem => {
  const targetInstance = searchEc2Instance(schedule.resourceId, ec2Result);
  if (targetInstance) {
    if (targetInstance.State?.Name === "running") {
      return createResultItem(schedule, `インスタンスは既に起動しているため何もしませんでした`);
    }

    // EC2の起動
    const command = new StartInstancesCommand({
      InstanceIds: [schedule.resourceId],
    });
    ec2.send(command);
    return createResultItem(schedule, `インスタンス起動の指示をしました`);
  }
  return createResultItem(schedule, `インスタンスが見つかりませんでした`);
};

/**
 * EC2インスタンスを停止
 * @param schedule
 * @param ec2Result
 * @returns
 */
const stopEc2Instance = (schedule: EventSchedule, ec2Result: DescribeInstancesCommandOutput): ResultItem => {
  const targetInstance = searchEc2Instance(schedule.resourceId, ec2Result);
  if (targetInstance) {
    if (targetInstance.State?.Name === "stopped") {
      return createResultItem(schedule, `インスタンスは既に停止しているため何もしませんでした`);
    }

    // EC2の停止
    const command = new StopInstancesCommand({
      InstanceIds: [schedule.resourceId],
    });
    ec2.send(command);
    return createResultItem(schedule, `インスタンス停止の指示を行いました`);
  }

  return createResultItem(schedule, `インスタンスが見つかりませんでした`);
};

/**
 * Lightsailインスタンスを起動
 * @param schedule
 * @param lightsailResult
 * @returns
 */
const startLightsailInstance = (schedule: EventSchedule, lightsailResult: GetInstancesCommandOutput): ResultItem => {
  const targetInstance = searchLightsailInstance(schedule.resourceId, lightsailResult);
  if (targetInstance) {
    if (targetInstance.state?.name === "running") {
      return createResultItem(schedule, `インスタンスは既に起動しているため何もしませんでした`);
    }

    // lightsailの起動
    const command = new StartInstanceCommand({
      instanceName: schedule.resourceId,
    });
    lightsail.send(command);
    return createResultItem(schedule, `インスタンス起動の指示をしました`);
  }

  return createResultItem(schedule, `インスタンスが見つかりませんでした`);
};

/**
 * Lightsailインスタンスを停止
 * @param schedule
 * @param lightsailResult
 * @returns
 */
const stopLightsailInstance = (schedule: EventSchedule, lightsailResult: GetInstancesCommandOutput): ResultItem => {
  const targetInstance = searchLightsailInstance(schedule.resourceId, lightsailResult);
  if (targetInstance) {
    if (targetInstance.state?.name === "stopped") {
      return createResultItem(schedule, `インスタンスは既に停止しているため何もしませんでした`);
    }

    // lightsailの停止
    const command = new StopInstanceCommand({
      instanceName: schedule.resourceId,
    });
    lightsail.send(command);
    return createResultItem(schedule, `インスタンス停止の指示を行いました`);
  }

  return createResultItem(schedule, `インスタンスが見つかりませんでした`);
};

/**
 * handler関数内で入力のjsonを1件ずつ処理する際の1件辺りの戻り値を作成する関数
 * @param schedule
 * @param details
 * @returns
 */
const createResultItem = (schedule: EventSchedule, details: string): ResultItem => {
  return {
    resouceType: schedule.resourceType!,
    resourceId: schedule.resourceId!,
    eventType: schedule.eventType!,
    details: details,
  };
};
