# ADR-005: Docker Memory Optimization Strategy

## Status
Accepted

## Context
User reported Docker containers consuming "8GB of memory" when expecting only 2 small containers. Investigation revealed:

1. **Actual memory usage**: ~1.8 GB total (not 8GB)
   - oshal containers: ~514 MB (api-server: 11MB, postgres: 24MB, keycloak: 479MB)
   - Plane containers: ~1.3 GB (12 containers from separate project)
   
2. **Container count mismatch**: 
   - Expected: 2 small containers
   - Reality: 3 oshal containers + 12 Plane containers = 15 total
   
3. **No memory constraints**: docker-compose.yml lacks memory limits, allowing unbounded growth

4. **Keycloak memory footprint**: Java-based Keycloak consumes 479 MB (reasonable for JVM, but optimizable)

## Decision

### 1. Add Memory Limits to All Services
Enforce explicit memory constraints in docker-compose.yml:
- **api-server**: 128 MB limit (Node.js alpine, lightweight)
- **postgres**: 256 MB limit (PostgreSQL alpine, small dataset)
- **keycloak**: 512 MB limit (Java app, optimized JVM heap)

### 2. Optimize Keycloak JVM Heap
Configure Keycloak to use minimal heap settings appropriate for development:
- Set `JAVA_OPTS_APPEND: "-Xms256m -Xmx512m"` (min 256MB, max 512MB heap)
- This prevents default JVM behavior of claiming large heap on startup

### 3. Make Keycloak Optional for Local Development
Document how to run without Keycloak for developers who don't need OIDC authentication:
- Add docker-compose.override.yml pattern for excluding Keycloak
- Update README with instructions for minimal setup

### 4. Add Resource Monitoring
Include health checks and resource monitoring:
- Document `docker stats` usage for monitoring
- Add script to check if memory limits are being hit

## Consequences

### Positive
- **Predictable resource usage**: Hard limits prevent memory bloat
- **Faster startup**: Keycloak with constrained heap starts faster
- **Better developer experience**: Clear documentation of resource requirements
- **Cost savings**: Lower memory footprint enables deployment on smaller instances

### Negative
- **Keycloak may hit limits**: If realm/user data grows, 512MB may be insufficient
- **Need monitoring**: Must watch for OOM errors indicating limits are too low
- **Migration path**: Existing deployments need to adopt new limits carefully

### Mitigation
- Monitor container restarts due to OOM kills
- Document how to increase limits if needed for production
- Provide separate production-ready limits in ADR or deployment guide

## Implementation Notes

1. Update docker-compose.yml with memory limits
2. Test all services start successfully with new constraints
3. Run full Playwright test suite to verify functionality
4. Document memory requirements in README.md
5. Create docker-compose.override.yml example for minimal setup
6. **Automated cleanup script**: `scripts/docker-cleanup.sh` provides routine maintenance
   - Removes dangling images (untagged intermediate layers)
   - Removes unused images older than 48 hours
   - Cleans build cache aggressively
   - Removes unused volumes
   - Displays before/after statistics
   - **Recommendation**: Run weekly to prevent disk space accumulation

## References
- Docker Compose memory limit syntax: `mem_limit: "512m"`
- Keycloak performance tuning: https://www.keycloak.org/server/configuration-production
- JVM memory flags: `-Xms` (initial heap), `-Xmx` (maximum heap)
