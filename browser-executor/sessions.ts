// Session leases: one opaque browser session per organization/project/job.
//
// A lease binds an opaque handle to exactly one (organizationId, projectId,
// jobId) triple and expires at its lease end. Handles, cookies, storage, and
// recordings are never shared across leases: resolving a handle under any
// other triple is denied, so a guest session cannot reuse a private user's
// browser state and one job cannot observe another's. No browser profile is
// inherited from any developer machine; the registry only mints fresh
// opaque handles.

import type { Decision, Denial } from "./types.ts";
import { denied } from "./types.ts";

export interface LeaseSpec {
  readonly organizationId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly leaseId: string;
  readonly expiresAtMs: number;
  readonly guest: boolean;
}

export interface SessionLease {
  readonly handle: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly leaseId: string;
  readonly expiresAtMs: number;
  readonly guest: boolean;
  readonly released: boolean;
}

export interface LeaseContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly jobId: string;
}

interface LeaseEntry {
  lease: SessionLease;
}

export interface SessionRegistry {
  acquire(spec: LeaseSpec, nowMs: number): SessionLease | Denial;
  resolve(handle: string, context: LeaseContext, nowMs: number): SessionLease | Denial;
  release(handle: string, context: LeaseContext): Decision;
}

function isDecision(value: SessionLease | Denial): value is Denial {
  return (value as Denial).ok === false;
}

export function createSessionRegistry(): SessionRegistry {
  const byHandle = new Map<string, LeaseEntry>();
  const activeByJob = new Map<string, string>();
  let sequence = 0;

  function jobKey(spec: LeaseSpec): string {
    return `${spec.organizationId}\u0000${spec.projectId}\u0000${spec.jobId}`;
  }

  function live(entry: LeaseEntry, nowMs: number): boolean {
    return !entry.lease.released && nowMs < entry.lease.expiresAtMs;
  }

  return {
    acquire(spec: LeaseSpec, nowMs: number): SessionLease | Denial {
      if (nowMs >= spec.expiresAtMs) {
        return denied("lease-invalid", `lease "${spec.leaseId}" is already expired`);
      }
      const key = jobKey(spec);
      const existingHandle = activeByJob.get(key);
      if (existingHandle !== undefined) {
        const existing = byHandle.get(existingHandle);
        if (existing !== undefined && live(existing, nowMs)) {
          return denied("conflict", `job "${spec.jobId}" already holds an active session lease`);
        }
      }
      sequence += 1;
      const handle = `sess_${spec.jobId}_${sequence}`;
      const lease: SessionLease = Object.freeze({
        handle,
        organizationId: spec.organizationId,
        projectId: spec.projectId,
        jobId: spec.jobId,
        leaseId: spec.leaseId,
        expiresAtMs: spec.expiresAtMs,
        guest: spec.guest,
        released: false,
      });
      byHandle.set(handle, { lease });
      activeByJob.set(key, handle);
      return lease;
    },

    resolve(handle: string, context: LeaseContext, nowMs: number): SessionLease | Denial {
      const entry = byHandle.get(handle);
      if (entry === undefined) {
        return denied("lease-invalid", "unknown session handle");
      }
      if (entry.lease.released) {
        return denied("lease-invalid", "session lease was released");
      }
      if (nowMs >= entry.lease.expiresAtMs) {
        return denied("lease-invalid", `session lease "${entry.lease.leaseId}" expired`);
      }
      if (
        entry.lease.organizationId !== context.organizationId ||
        entry.lease.projectId !== context.projectId ||
        entry.lease.jobId !== context.jobId
      ) {
        return denied(
          "lease-invalid",
          "session handle does not belong to this organization/project/job",
        );
      }
      return entry.lease;
    },

    release(handle: string, context: LeaseContext): Decision {
      const entry = byHandle.get(handle);
      if (entry === undefined) {
        return denied("lease-invalid", "unknown session handle");
      }
      if (
        entry.lease.organizationId !== context.organizationId ||
        entry.lease.projectId !== context.projectId ||
        entry.lease.jobId !== context.jobId
      ) {
        return denied(
          "lease-invalid",
          "session handle does not belong to this organization/project/job",
        );
      }
      entry.lease = Object.freeze({ ...entry.lease, released: true });
      const key = `${entry.lease.organizationId}\u0000${entry.lease.projectId}\u0000${entry.lease.jobId}`;
      if (activeByJob.get(key) === handle) {
        activeByJob.delete(key);
      }
      return { ok: true };
    },
  };
}

export function isLeaseDecision(value: SessionLease | Denial): value is Denial {
  return isDecision(value);
}
