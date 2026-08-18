/**
 * Sentinel value that asks flare-node to write the current server timestamp.
 *
 * Usage:
 *   await collection("posts").doc(id).update({ updatedAt: ServerTimeStamp })
 */
export const ServerTimeStamp = "ServerTimeStamp" as const;

/**
 * Object form of the same sentinel for payloads that prefer structured values.
 */
export const ServerTimeStampField = { $serverTimestamp: true } as const;
