import sodium from "libsodium-wrappers";

/**
 * The pairing key pair. Wopee.io seals the new API key to `publicKey` with a libsodium sealed box
 * (`crypto_box_seal`): only this process, holding `privateKey`, can open it, and the api keeps
 * nothing that could. Both halves are standard base64.
 */
export interface PairingKeyPair {
  publicKey: string;
  privateKey: string;
}

const B64 = () => sodium.base64_variants.ORIGINAL;

export async function generateKeyPair(): Promise<PairingKeyPair> {
  await sodium.ready;
  const { publicKey, privateKey } = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(publicKey, B64()),
    privateKey: sodium.to_base64(privateKey, B64()),
  };
}

/** The API key inside a sealed box addressed to `keys`. Throws when it was sealed to another key. */
export async function openSealedKey(
  sealed: string,
  keys: PairingKeyPair,
): Promise<string> {
  await sodium.ready;
  const opened = sodium.crypto_box_seal_open(
    sodium.from_base64(sealed, B64()),
    sodium.from_base64(keys.publicKey, B64()),
    sodium.from_base64(keys.privateKey, B64()),
  );
  return sodium.to_string(opened);
}
