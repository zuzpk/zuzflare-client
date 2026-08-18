export enum FlareResponseCodes {
    health = "health",
    authConfig = "auth_config",
    authRegistration = "auth/registration",
    authRegistrationVerificationRequired = "auth/registration-verification-required",
    authSession = "auth/session",
    authExchange = "auth/exchange",
    authLogout = "auth/logout",
    authSsrBridge = "auth/ssr_bridge",
    authSsrVerify = "auth/ssr_verify",
    accountRecovery = "account/recovery",
    emailVerification = "email/verification",
    verificationDispatch = "verification/dispatch",
    authProfile = "auth/profile",
    adminToken = "admin/token",
    documentDelete = "document/delete",
    documentsDelete = "documents/delete",
    documents = "documents",
    document = "document",
    documentCreate = "document/create",
    documentUpdate = "document/update",
    oauthProviderResponse = "oauth_provider_response",
    success = "success",
    response = "response",
}

export interface AuthConfigResponse {
    kind: string;
    appId: string;
    enabled: boolean;
    csrfToken?: string;
    cookie: {
        accessTokenName: string;
        refreshTokenName: string;
        csrfTokenName: string;
        path: string;
        secure: boolean;
        sameSite: 'Strict' | 'Lax' | 'None';
        accessTokenMaxAge: number;
        refreshTokenMaxAge: number;
        csrfTokenMaxAge: number;
    },
    providers: Record<string, any>;
    ssr: Record<string, any>;
}