---
title: "DHIS2 Production Deployment: Docker, Caddy & Automated Backups"
description: "How we deployed DHIS2 to a single Ubuntu server using Docker, Caddy for automatic HTTPS, and a lightweight backup container — with the tradeoffs and lessons learned."
pubDate: 2025-02-17
draft: false
tags: ["dhis2","docker","deployment","postgres","caddy","backup","devops"]
---

When we needed to take a DHIS2 instance to production for a health data program, the standard guidance points you toward large infrastructure. Load balancers, managed databases, separate backup services. That's the right answer at scale — but for a small national deployment with a predictable load profile, it's overkill that introduces cost and operational complexity you don't actually need.

We went with a single Ubuntu server running everything in Docker: DHIS2, PostgreSQL/PostGIS, Caddy as a reverse proxy, and a dedicated backup container. This is what we learned.

## Why These Choices

**Docker over bare metal:** DHIS2's dependencies (specific JVM versions, PostGIS extensions) are painful to manage directly on the host. Containers keep the environment reproducible and make upgrades safer — you swap an image rather than hoping `apt upgrade` doesn't break something.

**Caddy over Nginx:** Caddy handles TLS certificate provisioning and renewal automatically with zero configuration. For a deployment where nobody wants to think about certificates expiring at 2am, this is the right call. The entire proxy config is three lines.

**A backup container over cron jobs:** Running `pg_dump` on a schedule inside a dedicated container keeps the backup logic self-contained and restartable. The tradeoff is that `sleep 86400` loops can drift over time — if you need precise scheduling, use a cron-based container instead. For daily backups on a health reporting system, drift of a few minutes doesn't matter.

## Architecture

```
Internet
   ↓
Caddy (HTTPS 80/443)
   ↓
DHIS2 Core (8080 internal)
   ↓
PostgreSQL/PostGIS (5432 internal)
```

All four containers share a Docker network. The database and DHIS2 ports are never exposed to the public — only Caddy's 80 and 443 are open.

## What You Need Before Starting

- Ubuntu Server with Docker and Docker Compose installed
- A domain name with an A record pointing to the server's public IP
- Firewall with only ports 80 and 443 open publicly (5432 and 8080 internal only)

Verify DNS before proceeding:
```bash
ping your-domain.com
```

## Setting Up Caddy

Caddy's configuration lives in a single file. Place it at `/home/deploy/dhis2/Caddyfile`:

```
your-domain.com {
    reverse_proxy dhis2-core:8080
}
```

Run it attached to the same Docker network as your DHIS2 container:

```bash
sudo docker run -d \
  --name caddy \
  --network dhis2_default \
  -p 80:80 \
  -p 443:443 \
  -v /home/deploy/dhis2/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data \
  -v caddy_config:/config \
  --restart unless-stopped \
  caddy:latest
```

Check the logs after a minute — you should see a certificate issued with no TLS errors:

```bash
docker logs caddy
```

## Database Configuration

Use the PostGIS image from baosystems, which bundles the extensions DHIS2 needs:

```
ghcr.io/baosystems/postgis:12-3.3
```

Your `dhis.conf` must match whatever credentials you set on the container:

```
connection.url=jdbc:postgresql://db:5432/dhis2
connection.username=<your-username>
connection.password=<your-strong-password>
```

Use a real password. The DHIS2 database will contain patient identifiers and health records — the default `dhis`/`dhis` credentials are not acceptable in production.

## Automated Backups

The backup container runs a `pg_dump` loop, compresses the output, and prunes files older than 14 days. Backups land at `/opt/dhis2-backups` on the host:

```bash
sudo mkdir -p /opt/dhis2-backups
sudo chmod 755 /opt/dhis2-backups
```

```bash
sudo docker run -d \
  --name dhis2-db-backup \
  --network dhis2_default \
  -e PGPASSWORD=<your-db-password> \
  -v /opt/dhis2-backups:/backups \
  --restart unless-stopped \
  postgres:12 \
  sh -c "
  while true; do
    DATE=\$(date +%Y-%m-%d_%H-%M);
    pg_dump -h db -U dhis dhis2 | gzip > /backups/dhis2_\$DATE.sql.gz;
    find /backups -type f -name '*.gz' -mtime +14 -delete;
    sleep 86400;
  done
  "
```

Verify a backup ran:

```bash
docker logs dhis2-db-backup
ls /opt/dhis2-backups
```

To test a manual backup before relying on the schedule:

```bash
sudo docker exec dhis2-db-backup sh -c '
DATE=$(date +%Y-%m-%d_%H-%M);
pg_dump -h db -U dhis dhis2 | gzip > /backups/manual_$DATE.sql.gz
'
```

## Restoring from a Backup

```bash
gunzip -c backup_file.sql.gz | docker exec -i db psql -U dhis -d dhis2
```

Always test this in a staging environment first. A backup you've never restored is not a backup.

## Known Risks and Mitigations

| Risk | What to do about it |
|------|---------------------|
| Backups on the same server as the database | Set up offsite replication (S3 or equivalent) — this is the most important gap in this setup |
| Sleep-based drift in the backup loop | Switch to a cron-based container if precise timing matters |
| Certificate renewal failure | Caddy renews automatically, but monitor its logs — a stale cert will take the service down silently |
| No monitoring | Add Prometheus + Grafana or at minimum an uptime check before calling this production-ready |

The offsite backup gap is real. If the server is lost, you lose both the database and the backups. For a health information system, that's not acceptable. We addressed this by running a nightly `rclone` sync to S3, but that's outside the scope of this post.

## Maintenance Routine

**Monthly:** verify the SSL certificate is current, spot-check backup files, and do a restore test in staging.

**Quarterly:** update Docker images, review firewall rules, and validate backup retention is working correctly.

## What I'd Do Differently

**Start with offsite backups.** We added S3 sync later and had a few weeks where we were exposed. It should be part of the initial setup.

**Use Docker Compose from the start.** Running containers with long `docker run` commands works but is hard to reproduce. A `docker-compose.yml` makes the whole setup declarative and version-controlled.

**Add monitoring before going live.** Basic uptime checks and container health monitoring take an hour to set up. Skipping them means you find out about outages from users, not alerts.

## Resources

- [DHIS2 installation documentation](https://docs.dhis2.org/en/manage/installation/server-tools-manual-installation.html)
- [Caddy documentation](https://caddyserver.com/docs/)
- [baosystems PostGIS image](https://github.com/baosystems/docker-postgis)
