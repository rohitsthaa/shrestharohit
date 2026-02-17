---
title: "DHIS2 Production Deployment: Docker, Caddy & Automated Backups"
description: "Complete production deployment guide for DHIS2 with Docker, Caddy reverse proxy, PostgreSQL/PostGIS, and automated daily database backups with 14-day retention."
pubDate: 2025-02-17
draft: false
tags: ["dhis2","docker","deployment","postgres","caddy","backup","devops"]
---

> **Project:** DHIS2 Production Deployment  
> **Stack:** Docker + Caddy + PostgreSQL/PostGIS + Automated Backups

## 1. System Overview

### 1.1 Architecture

```
Internet
   ↓
Caddy (HTTPS 80/443)
   ↓
DHIS2 Core (8080 internal)
   ↓
PostgreSQL/PostGIS (5432 internal)
```

### 1.2 Container Responsibilities

| Container | Purpose |
|-----------|---------|
| d2-cluster-24231-core-1 | DHIS2 Application |
| d2-cluster-24231-db-1 | PostgreSQL/PostGIS Database |
| caddy | Reverse proxy + automatic SSL |
| dhis2-db-backup | Automated database backups |

## 2. Infrastructure Requirements

### 2.1 Server

- Ubuntu Server
- Docker installed
- Docker Compose installed
- Firewall configured (UFW or cloud security group)

### 2.2 Required Open Ports

**Public:**
```
80  (HTTP → Redirected to HTTPS)
443 (HTTPS)
```

**Internal only:**
```
5432 (PostgreSQL)
8080 (DHIS2)
```

## 3. DNS Configuration

Create A record:
```
your-domain.com → SERVER_PUBLIC_IP
```

Verify:
```bash
ping your-domain.com
```

## 4. Docker Network

Primary network: `d2-cluster-24231_default`

All service containers must be attached to this network to communicate.

Verify:
```bash
docker network ls
```

## 5. HTTPS Configuration (Caddy)

### 5.1 Caddyfile

**Location:** `/home/stc/dhis2/Caddyfile`

**Contents:**
```
your-domain.com {
    reverse_proxy d2-cluster-24231-core-1:8080
}
```

### 5.2 Run Caddy

```bash
sudo docker run -d \
  --name caddy \
  --network d2-cluster-24231_default \
  -p 80:80 \
  -p 443:443 \
  -v /home/stc/dhis2/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data \
  -v caddy_config:/config \
  --restart unless-stopped \
  caddy:latest
```

### 5.3 Verification

```bash
docker logs caddy
```

**Expected:**
- Certificate issued
- No TLS errors

**Access:**
```
https://your-domain.com
```

## 6. Database Configuration

### 6.1 PostgreSQL Image

```
ghcr.io/baosystems/postgis:12-3.3
```

### 6.2 Environment Variables

```
POSTGRES_DB=dhis2
POSTGRES_USER=dhis
POSTGRES_PASSWORD=dhis
```

### 6.3 dhis.conf

Must match database credentials:

```
connection.url=jdbc:postgresql://db:5432/dhis2
connection.username=dhis
connection.password=dhis
```

Verify:
```bash
docker exec -it d2-cluster-24231-core-1 cat /opt/dhis2/dhis.conf
```

## 7. Automated Database Backups

### 7.1 Backup Strategy

- Daily backup
- Compressed (.sql.gz)
- 14-day retention
- Stored on host
- Runs in dedicated container

**Backup directory:** `/opt/dhis2-backups`

Create directory:
```bash
sudo mkdir -p /opt/dhis2-backups
sudo chmod 755 /opt/dhis2-backups
```

### 7.2 Backup Container

```bash
sudo docker run -d \
  --name dhis2-db-backup \
  --network d2-cluster-24231_default \
  -e PGPASSWORD=dhis \
  -v /opt/dhis2-backups:/backups \
  --restart unless-stopped \
  postgres:12 \
  sh -c "
  while true; do
    echo 'Starting backup at ' \$(date);
    DATE=\$(date +%Y-%m-%d_%H-%M);
    pg_dump -h d2-cluster-24231-db-1 -U dhis dhis2 | gzip > /backups/dhis2_\$DATE.sql.gz;
    echo 'Backup finished at ' \$(date);
    find /backups -type f -name '*.gz' -mtime +14 -delete;
    sleep 86400;
  done
  "
```

### 7.3 Verify Backups

Check logs:
```bash
docker logs dhis2-db-backup
```

Check files:
```bash
ls /opt/dhis2-backups
```

Expected:
```
dhis2_YYYY-MM-DD_HH-MM.sql.gz
```

### 7.4 Manual Backup Test

```bash
sudo docker exec dhis2-db-backup sh -c '
DATE=$(date +%Y-%m-%d_%H-%M);
pg_dump -h d2-cluster-24231-db-1 -U dhis dhis2 | gzip > /backups/manual_$DATE.sql.gz
'
```

## 8. Restore Procedure

To restore:

```bash
gunzip -c backup_file.sql.gz | docker exec -i d2-cluster-24231-db-1 psql -U dhis -d dhis2
```

**Recommended:** Test restore in staging first.

## 9. Operational Commands

### Check Running Containers
```bash
docker ps
```

### Check Logs
```bash
docker logs container_name
```

### Restart Service
```bash
docker restart container_name
```

## 10. Security Considerations

✅ Database not publicly exposed  
✅ Only ports 80 and 443 open  
✅ Backups stored outside container  
⚠️ Use strong DB password in production

**Consider:**
- Offsite backups (S3)
- Firewall restrictions
- Fail2ban
- Monitoring

## 11. Known Risks

| Risk | Mitigation |
|------|------------|
| Backups stored on same server | Configure offsite backup |
| Sleep-based scheduling drift | Use cron-based container if precision required |
| Certificate renewal failure | Monitor Caddy logs |

## 12. Maintenance Checklist

**Monthly:**
- Verify SSL certificate
- Verify backup files
- Test restore process

**Quarterly:**
- Update Docker images
- Review firewall rules
- Validate backup retention

## 13. Final Production State

**Active containers:**
- d2-cluster-24231-core-1
- d2-cluster-24231-db-1
- caddy
- dhis2-db-backup

**Public Access:**
```
https://your-domain.com
```

---

## Next Steps

This deployment is production-ready for small to medium health information systems. For high-availability setups, consider:

1. **Disaster Recovery:** Offsite backup replication
2. **Monitoring:** Prometheus + Grafana for container metrics
3. **High Availability:** Database replication, load balancing
4. **Hardening:** Security audits for government/health infrastructure compliance

For additional guidance on monitoring, disaster recovery, or hardened production checklists, feel free to reach out.
