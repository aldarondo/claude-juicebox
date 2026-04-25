# One-Time NAS Deploy Key Setup

GitHub Actions deploys to the NAS via SSH through the Cloudflare Access tunnel.
Two security requirements need a one-time manual setup:

1. **NOPASSWD sudo** — the deploy user can run `docker` commands without a password prompt
2. **NAS_SSH_KNOWN_HOST secret** — pins the NAS host key so `StrictHostKeyChecking=yes` works in CI

---

## Step 1: Grant `charles` NOPASSWD sudo for docker

SSH into the NAS and run:

```bash
echo "charles ALL=(ALL) NOPASSWD: /usr/local/bin/docker" | sudo tee /etc/sudoers.d/charles-docker
chmod 0440 /etc/sudoers.d/charles-docker
```

Verify it works without a password prompt:

```bash
sudo /usr/local/bin/docker ps
```

---

## Step 2: Capture the NAS host key for CI

From a machine that can reach the NAS via Cloudflare Access SSH:

```bash
# Fetch the NAS host key through the tunnel
ssh-keyscan -t ed25519 nas-ssh.aldarondo.family 2>/dev/null
```

Copy the output line (format: `nas-ssh.aldarondo.family ssh-ed25519 AAAA...`).

Add it as a GitHub secret:
- Go to: `https://github.com/aldarondo/claude-juicebox/settings/secrets/actions`
- Create secret named: **`NAS_SSH_KNOWN_HOST`**
- Value: the single line from `ssh-keyscan` above

---

## Step 3: Remove the old NAS_SSH_PASSWORD secret

Once Step 1 and 2 are confirmed working:
- Delete the `NAS_SSH_PASSWORD` secret from GitHub Actions settings
- It is no longer referenced by any workflow

---

## Credential Rotation Schedule

Rotate these secrets every **90 days**:

| Secret | How to rotate |
|---|---|
| `NAS_SSH_KEY` | Generate new key pair on NAS, replace private key in GitHub, remove old public key from `~/.ssh/authorized_keys` |
| `NAS_SSH_KNOWN_HOST` | Re-run `ssh-keyscan` if NAS SSH host key was regenerated |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | Rotate via Cloudflare Access → Service Tokens |
| `GITHUB_TOKEN` | Auto-rotated by GitHub Actions — no action needed |

Next rotation due: **2026-07-25**
