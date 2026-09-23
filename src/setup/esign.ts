// The e-sign adapters, chosen once from config — shared by the API and the
// worker so the two processes cannot disagree about which provider a letter is
// signed through.
//
// The verifier (`DocusignSigner`) and the dispatcher (`DocusignDispatch`) are
// built over ONE `JwtGrantDocusign`, so a process holds one token and one
// discovered account rather than two of each, and the stampede guard in the
// transport covers both.
import type { Config } from "../config/config";
import type { Logger } from "../platform/log";
import type { ESignProvider, SignatureDispatch } from "../usecase/engagement/ports";
import { AttestedSigner } from "../infrastructure/esign/attested-signer";
import { DocusignSigner } from "../infrastructure/esign/docusign-signer";
import { DocusignDispatch } from "../infrastructure/esign/docusign-dispatch";
import { GlobalFetchHttp, JwtGrantDocusign } from "../infrastructure/esign/docusign-http";

export interface ESignAdapters {
  /** Verifies a signature before a letter is recorded as signed. */
  readonly signer: ESignProvider;
  /** Raises and watches envelopes. Null for a provider that sends nothing. */
  readonly dispatch: SignatureDispatch | null;
}

/**
 * Every missing variable is named in ONE message rather than failing on the
 * first: whoever is configuring this is reading a secret manager, and finding
 * out about three gaps one redeploy at a time is three redeploys.
 */
export function esignFor(cfg: Config, log: Logger): ESignAdapters {
  if (cfg.auth.esignProvider === "attested") {
    return { signer: new AttestedSigner(), dispatch: null };
  }
  const { oauthBase, integrationKey, userId, accountId, privateKeyPem } = cfg.docusign;
  const missing = [
    integrationKey === null ? "BIB_DOCUSIGN_INTEGRATION_KEY" : null,
    userId === null ? "BIB_DOCUSIGN_USER_ID" : null,
    privateKeyPem === null ? "BIB_DOCUSIGN_PRIVATE_KEY" : null,
  ].filter((v): v is string => v !== null);
  if (integrationKey === null || userId === null || privateKeyPem === null) {
    throw new Error(
      `BIB_ESIGN_PROVIDER=docusign but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
        "unset. DocuSign's JWT Grant needs the integration key, the impersonated user's id and " +
        "the RSA private key — in the API, which raises envelopes, AND in the worker, which " +
        "settles them. Set them, or set BIB_ESIGN_PROVIDER=attested for local development.",
    );
  }
  const transport = new JwtGrantDocusign(
    { oauthBase, integrationKey, userId, accountId, privateKeyPem },
    new GlobalFetchHttp(),
    log,
  );
  return { signer: new DocusignSigner(transport, log), dispatch: new DocusignDispatch(transport) };
}
