/** Client Request */
export enum FlareAction {
  SUBSCRIBE          = "subscribe",
  UNSUBSCRIBE        = "unsubscribe",
  WRITE              = "write",
  DELETE             = "delete",
  AUTH               = "auth",
  PING               = "ping",
  OFFLINE_SYNC       = "offline_sync",
  CALL               = "call",
  /** One-shot rich query (no real-time subscription) */
  QUERY              = "query",
  /** Presence */
  PRESENCE_JOIN      = "presence_join",
  PRESENCE_LEAVE     = "presence_leave",
  PRESENCE_HEARTBEAT = "presence_heartbeat",
}

/** Server Response */
export enum FlareEvent {
  SNAPSHOT       = "snapshot",
  CHANGE         = "change",
  ERROR          = "error",
  ACK            = "ack",
  PONG           = "pong",
  AUTH_OK        = "auth_ok",
  OFFLINE_ACK    = "offline_ack",
  CALL_RESPONSE  = "call_response",
  QUERY_RESULT   = "query_result",
  PRESENCE_STATE = "presence_state",
  PRESENCE_JOIN  = "presence_join",
  PRESENCE_LEAVE = "presence_leave",
}

export interface BaseMessage {
  id:   string;
  type: FlareAction | FlareEvent;
  ts:   number;
}

export interface SubscribeMessage extends BaseMessage {
  type: FlareAction.SUBSCRIBE;
  collection: string;
  docId?: string;
  query?: Record<string, unknown>;
  skipSnapshot?: boolean;
  resumeToken?: string;
}