import * as client from "openid-client";

/** Google sign-in for the web dashboard (authorization code + PKCE + state + nonce). */
export class DashboardOidc {
  private constructor(
    private readonly config: client.Configuration,
    private readonly redirectUri: string,
  ) {}

  static async create(clientId: string, clientSecret: string, publicUrl: string): Promise<DashboardOidc> {
    const config = await client.discovery(new URL("https://accounts.google.com"), clientId, clientSecret);
    return new DashboardOidc(config, new URL("/auth/google/callback", publicUrl).href);
  }

  async start() {
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(this.config, {
      redirect_uri: this.redirectUri,
      scope: "openid email profile",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
      prompt: "select_account",
    });
    return { url: url.href, verifier, state, nonce };
  }

  async finish(currentUrl: URL, checks: { verifier: string; state: string; nonce: string }) {
    const tokens = await client.authorizationCodeGrant(this.config, currentUrl, {
      pkceCodeVerifier: checks.verifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("No ID token");
    return claims as Record<string, unknown>;
  }
}
