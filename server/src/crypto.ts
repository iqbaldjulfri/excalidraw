import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export const randomToken = (bytes = 32) =>
  randomBytes(bytes).toString("base64url");

export const sha256Base64Url = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

export const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** AES-256-GCM; the output carries its IV and auth tag. */
export const encrypt = (key: Buffer, plaintext: string) => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
};

/** Returns null for anything tampered with or encrypted under another key. */
export const decrypt = (key: Buffer, encoded: string): string | null => {
  try {
    const data = Buffer.from(encoded, "base64url");
    if (data.length < IV_BYTES + TAG_BYTES) {
      return null;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      data.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(data.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
};

export const safeEqual = (a: string, b: string) => {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
};
