export interface EventSchedule {
  resourceType: string;
  resourceId: string;
  eventType: string;
  eventHour: number;
  eventMinute: number;
  weekdays: Array<number>;
  holiday?: number;
}
export type EventSchedules = Array<EventSchedule>;

export interface AWSLambdaEvent {
  schedules: EventSchedules;
}

export interface ApiHoliday {
  [date: string]: string;
}

export interface ResultItem {
  resouceType: string;
  resourceId: string;
  eventType: string;
  details: string;
}
