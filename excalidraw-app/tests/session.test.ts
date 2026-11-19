import { restoreHashAfterSignIn, signInUrl } from "../data/session";

describe("sign-in keeps a link's #fragment out of the server's sight", () => {
  afterEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("sends only the path to sign-in and restores the fragment afterwards", () => {
    window.history.replaceState(null, "", "/board?x=1#room=abc,SECRETKEY");

    const url = signInUrl();
    expect(url).not.toContain("SECRETKEY");
    expect(new URL(url, "http://x").searchParams.get("returnTo")).toBe(
      "/board?x=1",
    );

    // back from Google, without the fragment
    window.history.replaceState(null, "", "/board?x=1");
    restoreHashAfterSignIn();
    expect(window.location.hash).toBe("#room=abc,SECRETKEY");
  });

  it("doesn't restore the fragment on a different page", () => {
    window.history.replaceState(null, "", "/board#room=abc,KEY");
    signInUrl();

    window.history.replaceState(null, "", "/other");
    restoreHashAfterSignIn();

    expect(window.location.hash).toBe("");
  });
});
