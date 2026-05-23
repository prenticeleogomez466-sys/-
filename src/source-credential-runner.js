import { buildCredentialStatus, writeCredentialStatus } from "./source-credentials.js";

try {
  const status = await buildCredentialStatus({ live: process.argv.includes("--live") });
  const paths = writeCredentialStatus(status);
  console.log(JSON.stringify({ ok: status.ok, policy: status.policy, paths }, null, 2));
  if (!status.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
