#!/bin/bash
###############################################################################
# CHANGE LOG
# -----------------------------------------------------------------------------
# DATE         | AUTHOR  | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of Docker maintenance script
###############################################################################

###############################################################################
# Docker Maintenance and Cleanup Script
#
# This script performs routine Docker cleanup operations to reclaim disk space
# and remove unused resources. It displays before/after statistics and a
# summary of space reclaimed.
#
# Operations performed:
# 1. Remove dangling images (untagged intermediate layers)
# 2. Remove unused images older than 48 hours (excludes running containers)
# 3. Clean build cache (aggressive cleanup)
# 4. Remove unused volumes (preserves volumes in use)
#
# Usage: ./scripts/docker-cleanup.sh
# Requirements: Docker must be running
###############################################################################

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

# Header
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         Docker Maintenance & Cleanup Script               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    log_error "Docker is not running. Please start Docker and try again."
    exit 1
fi

log_success "Docker is running"
echo ""

# Capture before statistics
log_info "Capturing current disk usage..."
BEFORE_STATS=$(docker system df)
echo "$BEFORE_STATS"
echo ""

# Extract space values before cleanup
IMAGES_BEFORE=$(echo "$BEFORE_STATS" | grep "Images" | awk '{print $4}')
CONTAINERS_BEFORE=$(echo "$BEFORE_STATS" | grep "Containers" | awk '{print $4}')
VOLUMES_BEFORE=$(echo "$BEFORE_STATS" | grep "Local Volumes" | awk '{print $4}')
BUILD_CACHE_BEFORE=$(echo "$BEFORE_STATS" | grep "Build Cache" | awk '{print $4}')

echo ""
log_info "Starting cleanup operations..."
echo ""

# Step 1: Remove dangling images
echo -e "${YELLOW}═══ Step 1: Removing dangling images ═══${NC}"
DANGLING_OUTPUT=$(docker image prune -f 2>&1)
echo "$DANGLING_OUTPUT"
log_success "Dangling images removed"
echo ""

# Step 2: Remove unused images older than 48 hours
echo -e "${YELLOW}═══ Step 2: Removing unused images (>48h) ═══${NC}"
UNUSED_OUTPUT=$(docker image prune -a --filter "until=48h" -f 2>&1)
echo "$UNUSED_OUTPUT"
log_success "Unused images removed"
echo ""

# Step 3: Clean build cache
echo -e "${YELLOW}═══ Step 3: Cleaning build cache ═══${NC}"
BUILD_OUTPUT=$(docker builder prune -a -f 2>&1)
echo "$BUILD_OUTPUT"
log_success "Build cache cleaned"
echo ""

# Step 4: Remove unused volumes
echo -e "${YELLOW}═══ Step 4: Removing unused volumes ═══${NC}"
VOLUME_OUTPUT=$(docker volume prune -f 2>&1)
echo "$VOLUME_OUTPUT"
log_success "Unused volumes removed"
echo ""

# Capture after statistics
log_info "Capturing updated disk usage..."
AFTER_STATS=$(docker system df)
echo "$AFTER_STATS"
echo ""

# Extract space values after cleanup
IMAGES_AFTER=$(echo "$AFTER_STATS" | grep "Images" | awk '{print $4}')
CONTAINERS_AFTER=$(echo "$AFTER_STATS" | grep "Containers" | awk '{print $4}')
VOLUMES_AFTER=$(echo "$AFTER_STATS" | grep "Local Volumes" | awk '{print $4}')
BUILD_CACHE_AFTER=$(echo "$AFTER_STATS" | grep "Build Cache" | awk '{print $4}')

# Summary
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    Cleanup Summary                        ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Before → After:${NC}"
echo -e "  Images:      ${YELLOW}${IMAGES_BEFORE}${NC} → ${GREEN}${IMAGES_AFTER}${NC}"
echo -e "  Containers:  ${YELLOW}${CONTAINERS_BEFORE}${NC} → ${GREEN}${CONTAINERS_AFTER}${NC}"
echo -e "  Volumes:     ${YELLOW}${VOLUMES_BEFORE}${NC} → ${GREEN}${VOLUMES_AFTER}${NC}"
echo -e "  Build Cache: ${YELLOW}${BUILD_CACHE_BEFORE}${NC} → ${GREEN}${BUILD_CACHE_AFTER}${NC}"
echo ""
log_success "Docker cleanup completed successfully!"
echo ""
log_info "Recommendation: Run this script weekly to prevent disk space accumulation"
echo ""
