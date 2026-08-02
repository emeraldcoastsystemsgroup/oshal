/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Slice barrel for the Operations Stream — the event-to-action pipeline. Alerts land verbatim, normalize to one shape, take a deterministic identity, consolidate onto a single incident, correlate over infrastructure topology, freeze evidence, and drive one ticket through to a verified action. Every consumer imports from '@/features/alert-pipeline'; nothing reaches past this barrel.
 */

export * from './services';
