# Deploying to a Linux server (systemd)

This deploys the app to any Linux box you have SSH access to. It was written for
an **Amazon Linux 2023 / aarch64 EC2 instance** (whose repo Node is too old), but
works on any x64/arm64 Linux with systemd.

The app needs **Node ≥ 22.5** for the built-in `node:sqlite` module. `setup.sh`
installs the official Node 22 binary automatically when the system Node is missing
or too old, so the distro's package version doesn't matter.

## One-time / update deploy

**1. Package the code locally** (working tree, minus junk):

```bash
cd /path/to/SecretHitler
tar --exclude='./.git' --exclude='./node_modules' --exclude='./.data' \
    --exclude='./.claude' --exclude='*.db' --exclude='*.db-wal' \
    --exclude='*.db-shm' --exclude='.DS_Store' \
    -czf /tmp/secret-hitler.tar.gz -C "$(pwd)" .
```

**2. Copy it to the instance** (Amazon Linux's default user is `ec2-user`):

```bash
scp /tmp/secret-hitler.tar.gz ec2-user@YOUR_HOST:/tmp/
```

**3. Extract and bootstrap on the instance:**

```bash
ssh ec2-user@YOUR_HOST '
  sudo mkdir -p /opt/secret-hitler &&
  sudo tar -xzf /tmp/secret-hitler.tar.gz -C /opt/secret-hitler &&
  sudo bash /opt/secret-hitler/deploy/setup.sh
'
```

The app is now live on port **3000**.

`setup.sh` is idempotent — re-run steps 1–3 to ship an update. It skips the Node
install if already current, re-runs `npm ci`, rewrites the systemd unit, and
restarts the service. The SQLite database in `.data/` is left untouched.

## Port 80

```bash
PORT=80 sudo -E bash /opt/secret-hitler/deploy/setup.sh
```

The script grants `CAP_NET_BIND_SERVICE` automatically for ports < 1024.

## EC2 / firewall

The app binds `0.0.0.0`, so the only thing left is to open the port: add an
inbound **TCP 3000** (or 80) rule to the instance's security group, scoped to your
players' IPs or `0.0.0.0/0`.

## Managing the service

```bash
sudo systemctl status secret-hitler
sudo journalctl -u secret-hitler -f      # live logs
sudo systemctl restart secret-hitler
sudo systemctl stop secret-hitler
```

## What setup.sh does

1. Installs Node 22 (official `linux-{x64,arm64}` binary → `/usr/local`) if the
   system Node is missing or < 22.5.
2. Creates a locked-down `secrethitler` system user (no shell, no home).
3. Runs `npm ci --omit=dev` (only dependency is `express`).
4. Creates a writable `.data/` dir for the SQLite file, owned by the service user,
   so the code tree itself can stay read-only.
5. Writes, enables, and starts a hardened systemd unit
   (`/etc/systemd/system/secret-hitler.service`) that restarts on failure and
   starts on boot.

## Security note

The app has **no authentication**, and `GET /api/stats` lists all active game
codes and player counts. That's fine for an in-person party game, but don't treat
the data as private if you expose the port to the public internet.
