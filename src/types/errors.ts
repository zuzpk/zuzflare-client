export enum FlareErrors {
    authEmailNotVerified = "auth/email-not-verified",
    authEmailAlreadyVerified = "auth/email-already-verified",
    authInvalidToken = "auth/invalid-token",
    authUserDisabled = "auth/user-disabled",
    authUserNotFound = "auth/user-not-found",
    authWrongPassword = "auth/wrong-password",
    authEmailAlreadyInUse = "auth/email-already-in-use",
    authInvalidEmail = "auth/invalid-email",
    authWeakPassword = "auth/weak-password",
    authTooManyRequests = "auth/too-many-requests",
    authInternalError = "auth/internal-error",
}