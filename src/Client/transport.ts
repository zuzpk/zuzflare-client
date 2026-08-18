import { TransportOptions } from "../types/transport";

// RSA-OAEP encryption (WebCrypto — works in browser + Node ≥ 18)
/**
 * Import an RSA-OAEP public key from a PEM string.
 * Works in both browser (WebCrypto) and Node.js ≥ 18.
 */
async function importPublicKey(pem: string): Promise<CryptoKey> {
    // Strip PEM headers and decode base64
    const b64 = pem
        .replace(/-----BEGIN PUBLIC KEY-----/, "")
        .replace(/-----END PUBLIC KEY-----/, "")
        .replace(/\s+/g, "");

    const binary = typeof atob !== "undefined"
        ? atob(b64)
        : Buffer.from(b64, "base64").toString("binary");

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const crypto = globalThis.crypto ?? (await import("node:crypto")).webcrypto as Crypto;
    return crypto.subtle.importKey(
        "spki",
        bytes.buffer,
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["encrypt"]
    );
}

/**
 * Encrypt a JSON message with the RSA public key.
 * Returns the envelope `{ enc: "rsa", data: "<base64>" }` as a JSON string.
 */
async function rsaEncrypt(message: object, publicKeyPem: string): Promise<string> {
    const key = await importPublicKey(publicKeyPem);
    const plaintext = new TextEncoder().encode(JSON.stringify(message));
    const crypto = globalThis.crypto ?? (await import("node:crypto")).webcrypto as Crypto;
    const cipherBuf = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, plaintext);
    const b64 = typeof btoa !== "undefined"
        ? btoa(String.fromCharCode(...new Uint8Array(cipherBuf)))
        : Buffer.from(cipherBuf).toString("base64");
    return JSON.stringify({ enc: "rsa", data: b64 });
}

// 
export class FlareTransport {

  private socket: WebSocket | null = null;
  private reconnectInterval: number;
  private maxReconnectDelay: number;
  private isConnected = false;
  private shouldReconnect = true;
  private options: TransportOptions;
  private messageQueue: any[] = [];
  private heartbeatInterval: ReturnType<typeof setTimeout> | null = null;
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TransportOptions) {
    this.options = options;
    this.reconnectInterval = options.reconnectDelay || 2;
    this.maxReconnectDelay = options.maxReconnectDelay || 60;
    this.log('Transport initialized', options.url);
  }

  connect() {
    if (this.socket) {
      this.log('Socket already exists, skipping connection');
      return;
    }

    this.log('Connecting to', this.options.url);
    this.socket = new WebSocket(this.options.url);

    // Connection timeout
    this.connectionTimeout = setTimeout(() => {
      if (!this.isConnected) {
        this.log('Connection timeout');
        this.socket?.close();
        this.handleReconnect();
      }
    }, 10000);

    this.socket.onopen = () => {
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      this.isConnected = true;
      this.reconnectInterval = this.options.reconnectDelay || 2;
      this.log('Connected to server');
      this.options.onOpen?.();

      // Start heartbeat
      this.startHeartbeat();

      // Flush message queue
      this.flushQueue();
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.options.onMessage(data);
      } catch (e) {
        this.log('Parse error', e);
        this.options.onError?.(e as Error);
      }
    };

    this.socket.onerror = (event) => {
      this.log('WebSocket error', event);
      this.options.onError?.(new Error('WebSocket error'));
    };

    this.socket.onclose = (event) => {
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      this.isConnected = false;
      this.socket = null;
      this.stopHeartbeat();
      
      this.log('Connection closed', event.code, event.reason);
      this.options.onClose?.();

      // Only reconnect if not a clean close and auto-reconnect is enabled
      if (event.code !== 1000 && this.shouldReconnect && this.options.autoReconnect) {
        this.handleReconnect();
      }
    };
  }

  private handleReconnect() {
    const delay = this.reconnectInterval * 1000;
    this.log(`Reconnecting in ${this.reconnectInterval}s...`);
    
    setTimeout(() => {
      // Exponential backoff
      this.reconnectInterval = Math.min(this.reconnectInterval * 2, this.maxReconnectDelay);
      this.connect();
    }, delay);
  }

  private startHeartbeat() {
    // Send ping every 30 seconds to keep connection alive
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected) {
        this.send({ type: 'ping', id: Date.now().toString(), ts: Date.now() });
      }
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private flushQueue() {
    this.log('Flushing message queue', this.messageQueue.length);
    
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        this.send(message);
      }
    }
  }

  send(message: object) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const doSend = (payload: string) => {
        try {
          this.socket!.send(payload);
          this.log('Sent message', message);
        } catch (err) {
          this.log('Send error', err);
          this.messageQueue.push(message);
        }
      };

      if (this.options.publicKey) {
        rsaEncrypt(message, this.options.publicKey)
          .then(doSend)
          .catch(err => {
            this.log('RSA encrypt error — sending plaintext', err);
            doSend(JSON.stringify(message));
          });
      } else {
        doSend(JSON.stringify(message));
      }
    } else {
      this.log('Socket not ready, queueing message');
      this.messageQueue.push(message);
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    
    if (this.socket) {
      this.socket.close(1000, 'Client disconnect');
      this.socket = null;
    }
    
    this.isConnected = false;
    this.log('Disconnected');
  }

  get connected(): boolean {
    return this.isConnected;
  }

  private log(...args: any[]) {
    if (this.options.debug) {
      console.log('[FlareTransport]', ...args);
    }
  }
}