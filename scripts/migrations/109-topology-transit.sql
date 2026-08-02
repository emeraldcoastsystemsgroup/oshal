/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | oshal_topology_node.transit_allowed — separates "this node may be REACHED" from "the walk may CONTINUE through it". A shared dependency needs to stay visible as a dependency while not acting as a bridge between everything that depends on it.
 */

-- =============================================================================
-- Migration 109: separate reachability from transit
--
-- `traverse_via` gates ENTRY to a node: it decides which edge types may arrive.
-- That is the right control for "do not reach this node over that kind of edge",
-- but it cannot express the far more common shape:
--
--   a hub that MUST stay visible as a dependency, while NOT acting as a bridge
--   between every peer that depends on it.
--
-- Concretely, in a star topology every worker depends on one control-plane node.
-- Two hops through that hub connects every worker to every other worker, so a
-- single failure anywhere correlates the entire estate into one component. Using
-- `traverse_via` to stop it removes the hub from the result altogether, which
-- discards the one relationship that actually explains the incident.
--
-- `transit_allowed = false` keeps the node in the answer at its true hop count
-- and stops the walk expanding OUT of it. Reachability and transit are different
-- questions and now have different switches.
--
-- Default TRUE: existing topology behaves exactly as before until a hub is marked.
-- =============================================================================

ALTER TABLE oshal_topology_node
  ADD COLUMN IF NOT EXISTS transit_allowed BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN oshal_topology_node.transit_allowed IS
  'False marks a hub: the node is still reachable and still reported at its true hop count, but the traversal does not expand through it. Use for shared dependencies (a control plane, a message bus, a shared datastore) that would otherwise bridge every peer that depends on them into one component.';

-- A partial index because the interesting set is small: only marked hubs.
CREATE INDEX IF NOT EXISTS idx_topology_node_no_transit
  ON oshal_topology_node (node_key)
  WHERE NOT transit_allowed;
