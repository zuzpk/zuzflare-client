export type TransportOptions = {
  url: string;
  onMessage: (data: any) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  debug?: boolean;
  /** RSA public key (PEM). When set, all outgoing messages are RSA-OAEP encrypted. */
  publicKey?: string;
};