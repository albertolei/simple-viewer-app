/*---------------------------------------------------------------------------------------------
* Copyright (c) 2018 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
import { UserManagerSettings, UserManager, User } from "oidc-client";
import { IDisposable, BeEvent, ActivityLoggingContext } from "@bentley/bentleyjs-core";
import { AccessToken, UserProfile, UrlDiscoveryClient, Config } from "@bentley/imodeljs-clients";

/**
 * A client which helps with OIDC sign in
 */
export default class OidcClient implements IDisposable {
  private _userManager?: UserManager;
  private _accessToken?: AccessToken;
  private readonly _ready: Promise<void>;
  public readonly onUserStateChanged = new BeEvent<(token: AccessToken | undefined) => void>();

  constructor() {
    this._ready = new Promise(async (resolve: () => void) => {
      await this.createUserManager();
      resolve();
    });
  }

  private createUserManager(): Promise<UserManager> {
    return createOidcSettings().then((settings: UserManagerSettings) => {
      this._userManager = new UserManager(settings);
      this._userManager.events.addUserLoaded(this._onUserLoaded);
      this._userManager.events.addSilentRenewError(this._onError);
      this._userManager.events.addAccessTokenExpired(this._onUserExpired);
      this._userManager.events.addUserUnloaded(this._onUserUnloaded);
      this._userManager.events.addUserSignedOut(this._onUserSignedOut);
      this._userManager.getUser().then((user: User | undefined) => {
        if (user && !user.expired)
          this._onUserLoaded(user);
        else
          this._onUserExpired();
      }, this._onError);

      if (window.location.pathname === Config.App.getString("imjs_test_oidc_redirect_path")) {
        this._userManager.signinRedirectCallback().then(() => {
          window.location.replace("/");
        }, this._onError);
        this._userManager.signoutRedirectCallback().then(() => {
          window.location.replace("/");
        }, this._onError);
      }
      return this._userManager;
    });
  }

  public get ready(): Promise<void> { return this._ready; }

  public dispose() {
    if (!this._userManager)
      return;

    this._userManager.events.removeUserLoaded(this._onUserLoaded);
    this._userManager.events.removeSilentRenewError(this._onError);
    this._userManager.events.removeAccessTokenExpired(this._onUserExpired);
    this._userManager.events.removeUserUnloaded(this._onUserUnloaded);
    this._userManager.events.removeUserSignedOut(this._onUserSignedOut);
  }

  private _onUserStateChanged = (token: AccessToken | undefined, _reason: string) => {
    this._accessToken = token;

    if (this.isLoading) {
      // no need to raise the event as we're about to get a redirect
      return;
    }

    this.onUserStateChanged.raiseEvent(token);
  }

  /**
   * Dispatched when:
   * - a valid user is found (on startup, after token refresh or token callback)
   */
  private _onUserLoaded = (user: User) => {
    this._onUserStateChanged(createAccessToken(user), "loaded");
  }

  /**
   * Dispatched when:
   * - no valid user is found on startup
   * - a valid user object expires
   */
  private _onUserExpired = () => {
    this._onUserStateChanged(undefined, "expired");
  }

  /**
   * Dispatched when:
   * - the user is logged out at the auth server
   */
  private _onUserUnloaded = () => {
    this._onUserStateChanged(undefined, "unloaded");
  }

  /**
   * Dispatched when:
   * - the user logs out (with a call to the userManager function)
   */
  private _onUserSignedOut = () => {
    this._onUserStateChanged(undefined, "signed out");
  }

  /**
   * Dispatched when:
   * - the user manager's loading process produces an error
   * - the silent renewal process fails
   */
  private _onError = (e: Error) => {
    console.error(e); // tslint:disable-line:no-console
    this._onUserStateChanged(undefined, e.message);
  }

  /** Get the access token of currently logged-in user */
  public get accessToken() { return this._accessToken; }

  /** Is user being logged in */
  public get isLoading() { return (window.location.pathname === Config.App.getString("imjs_test_oidc_redirect_path")); }

  /**
   * Start the sign-in procedure.
   *
   * The call redirects application to specific path and then
   * redirects back to root when sign-in is complete.
   */
  public signIn() {
    if (!this._userManager)
      throw new Error("OidcClient is not ready to be used yet");
    this._userManager.signinRedirect();
  }

  /**
   * Start the sign-out procedure.
   *
   * The call redirects application to specific path and then
   * redirects back to root when sign-out is complete.
   */
  public signOut() {
    if (!this._userManager)
      throw new Error("OidcClient is not ready to be used yet");
    this._userManager.signoutRedirect();
  }
}

async function createOidcSettings(): Promise<UserManagerSettings> {
  const loggingContext = new ActivityLoggingContext("");
  const urlDiscoClient = new UrlDiscoveryClient();
  // Discover url for OIDC using buddi service. This would work if 'imjs_buddi_url' is set in configuration
  const authorityUrl = await urlDiscoClient.discoverUrl(loggingContext, "IMSOpenID" /*search key for use with url discovery service*/, undefined);
  const oidcPath = Config.App.getString("imjs_test_oidc_redirect_path"); // must be set in config
  const clientId = Config.App.getString("imjs_test_oidc_client_id"); // must be set in config
  return {
    authority: authorityUrl,
    client_id: clientId,
    redirect_uri: `${window.location.protocol}//${window.location.host}${oidcPath}`,
    silent_redirect_uri: `${window.location.protocol}//${window.location.host}${oidcPath}`,
    response_type: "id_token token",
    scope: "openid email profile organization feature_tracking imodelhub rbac-service context-registry-service",
  };
}

function createAccessToken(user: User): AccessToken {
  const startsAt: Date = new Date(user.expires_at - user.expires_in!);
  const expiresAt: Date = new Date(user.expires_at);
  const userProfile = new UserProfile(user.profile.given_name, user.profile.family_name, user.profile.email!, user.profile.sub, user.profile.org_name!, user.profile.org!, user.profile.ultimate_site!, user.profile.usage_country_iso!);
  return AccessToken.fromJsonWebTokenString(user.access_token, userProfile, startsAt, expiresAt);
}
