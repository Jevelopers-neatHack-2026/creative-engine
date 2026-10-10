/**
 * TEST ONLY: deterministic stand-in for cost-intelligence. Its sample amounts and
 * budget arithmetic are fixture values, never production prices or ledger state.
 */
export class FakeMeteringAuthority {
  constructor({
    budget = '1.00',
    holdByAttempt = {},
    defaultHold = '0.08',
    consumedByAttempt = {},
    defaultConsumed = '0.03',
  } = {}) {
    this.availableCents = toCents(budget);
    this.holdByAttempt = new Map(Object.entries(holdByAttempt).map(([key, value]) => [key, toCents(value)]));
    this.defaultHoldCents = toCents(defaultHold);
    this.consumedByAttempt = new Map(Object.entries(consumedByAttempt).map(([key, value]) => [key, toCents(value)]));
    this.defaultConsumedCents = toCents(defaultConsumed);
    this.reservations = new Map();
    this.byAttempt = new Map();
    this.observationsById = new Map();
    this.effectiveObservationKeys = new Map();
    this.transports = new Map();
    this.effectiveChargeKeys = new Set();
  }

  async reserveAttempt(attempt) {
    const existingId = this.byAttempt.get(attempt.billable_attempt_id);
    if (existingId) {
      const existing = this.reservations.get(existingId);
      return {
        status: 'reserved',
        reservation_id: existing.reservation_id,
        billable_attempt_id: existing.billable_attempt_id,
        held_amount: amount(existing.held_cents),
        lease_id: existing.lease_id,
      };
    }
    const heldCents = this.holdByAttempt.get(attempt.billable_attempt_id) ?? this.defaultHoldCents;
    if (heldCents > this.availableCents) return { status: 'denied', reason: 'budget_unavailable' };

    // No await occurs between checking and debiting capacity: this test authority
    // models an atomic reservation decision for concurrent fixture callers.
    this.availableCents -= heldCents;
    const reservation = {
      reservation_id: `test-reservation:${attempt.billable_attempt_id}`,
      billable_attempt_id: attempt.billable_attempt_id,
      logical_operation_id: attempt.logical_operation_id,
      tenant_id: attempt.tenant_id,
      project_id: attempt.project_id,
      held_cents: heldCents,
      lease_id: `test-lease:${attempt.billable_attempt_id}`,
      state: 'reserved',
      transport_attempt_ids: new Set(),
      observation_ids: new Set(),
      unknown_reasons: [],
      lease_expired: false,
    };
    this.reservations.set(reservation.reservation_id, reservation);
    this.byAttempt.set(attempt.billable_attempt_id, reservation.reservation_id);
    return {
      status: 'reserved',
      reservation_id: reservation.reservation_id,
      billable_attempt_id: reservation.billable_attempt_id,
      held_amount: amount(heldCents),
      lease_id: reservation.lease_id,
    };
  }

  async markAttemptInFlight(command) {
    const reservation = this.#reservation(command.reservation_id);
    if (reservation.state !== 'reserved') throw new Error('fixture reservation is not reserved');
    reservation.state = 'in_flight';
    return { status: 'in_flight', reservation_id: reservation.reservation_id };
  }

  async releaseBeforeDispatch(command) {
    const reservation = this.#reservation(command.reservation_id);
    if (!['reserved', 'in_flight'].includes(reservation.state)) {
      throw new Error('fixture cannot release a dispatched or settled hold');
    }
    reservation.state = 'released_before_dispatch';
    this.availableCents += reservation.held_cents;
    return {
      status: 'released_before_dispatch',
      reservation_id: reservation.reservation_id,
      released_amount: amount(reservation.held_cents),
    };
  }

  async recordTransportAttempt(command) {
    const reservation = this.#reservation(command.reservation_id);
    if (reservation.state !== 'in_flight') throw new Error('transport must be recorded while in flight');
    if (reservation.transport_attempt_ids.has(command.transport_attempt_id)) {
      throw new Error('duplicate fixture transport attempt');
    }
    reservation.transport_attempt_ids.add(command.transport_attempt_id);
    const previous = this.transports.get(command.transport_attempt_id);
    if (previous) throw new Error('transport identity reused across attempts');
    this.transports.set(command.transport_attempt_id, command.billable_attempt_id);
    return { status: 'recorded', transport_attempt_id: command.transport_attempt_id };
  }

  async recordUsageObservation(command) {
    const observation = command.observation;
    const reservationId = this.byAttempt.get(observation.billable_attempt_id);
    if (!reservationId) throw new Error('usage observation has no fixture reservation');
    const reservation = this.#reservation(reservationId);
    if (observation.tenant_id !== reservation.tenant_id || observation.project_id !== reservation.project_id) {
      throw new Error('fixture usage scope mismatch');
    }
    if (reservation.observation_ids.has(observation.source_observation_id)) {
      return {
        status: 'duplicate',
        source_observation_id: observation.source_observation_id,
        effective_billable_attempt_id: observation.billable_attempt_id,
      };
    }
    reservation.observation_ids.add(observation.source_observation_id);
    this.observationsById.set(observation.source_observation_id, structuredClone(observation));

    // The same provider request reported by direct usage and a trace remains one
    // effective fixture observation. The external service must define its real key.
    const effectiveKey = observation.provider_request_id
      ? `request:${observation.provider_name}:${observation.provider_request_id}`
      : `attempt:${observation.billable_attempt_id}:source:${observation.source}`;
    const existingAttempt = this.effectiveObservationKeys.get(effectiveKey);
    if (existingAttempt && existingAttempt !== observation.billable_attempt_id) {
      throw new Error('provider request identity was reused across billable attempts');
    }
    this.effectiveObservationKeys.set(effectiveKey, observation.billable_attempt_id);
    const wasKnown = this.effectiveChargeKeys.has(effectiveKey);
    this.effectiveChargeKeys.add(effectiveKey);
    return {
      status: wasKnown ? 'duplicate' : 'accepted',
      source_observation_id: observation.source_observation_id,
      effective_billable_attempt_id: observation.billable_attempt_id,
    };
  }

  async settleReservation(command) {
    const reservation = this.#reservation(command.reservation_id);
    const sourceObservation = this.observationsById.get(command.source_observation_id);
    if (!sourceObservation || sourceObservation.completeness !== 'complete') {
      reservation.state = 'held_for_reconciliation';
      return {
        reservation_id: reservation.reservation_id,
        status: 'held_for_reconciliation',
        reason: 'fixture_usage_incomplete',
      };
    }
    if (reservation.lease_expired || reservation.unknown_reasons.length > 0) {
      reservation.state = 'held_for_reconciliation';
      return {
        reservation_id: reservation.reservation_id,
        status: 'held_for_reconciliation',
        reason: 'fixture_unknown_outcome',
      };
    }
    const consumedCents = this.consumedByAttempt.get(reservation.billable_attempt_id) ?? this.defaultConsumedCents;
    if (consumedCents > reservation.held_cents) throw new Error('fixture consumed amount exceeds its held amount');
    const releasedUnusedCents = reservation.held_cents - consumedCents;
    reservation.state = 'settled';
    reservation.consumed_cents = consumedCents;
    reservation.released_unused_cents = releasedUnusedCents;
    this.availableCents += releasedUnusedCents;
    return {
      reservation_id: reservation.reservation_id,
      status: 'settled',
      consumed_amount: amount(consumedCents),
      released_unused_amount: amount(releasedUnusedCents),
      posting_refs: [`test-posting:${reservation.billable_attempt_id}`],
    };
  }

  async markOutcomeUnknown(command) {
    const reservation = this.#reservation(command.reservation_id);
    if (reservation.state !== 'settled' && reservation.state !== 'released_before_dispatch') {
      reservation.state = 'held_for_reconciliation';
    }
    reservation.unknown_reasons.push(command.reason);
    return {
      status: 'held_for_reconciliation',
      reservation_id: reservation.reservation_id,
      reason: command.reason,
      held_amount: amount(reservation.held_cents),
    };
  }

  expireWorkerLease(billableAttemptId) {
    const reservation = this.#reservation(this.byAttempt.get(billableAttemptId));
    reservation.lease_expired = true;
    if (reservation.state === 'in_flight') reservation.state = 'lease_expired_in_flight';
    return {
      status: 'lease_expired',
      hold_state: 'retained',
      held_amount: amount(reservation.held_cents),
    };
  }

  reservationFor(billableAttemptId) {
    const reservationId = this.byAttempt.get(billableAttemptId);
    return reservationId ? structuredClone({
      ...this.#reservation(reservationId),
      transport_attempt_ids: [...this.#reservation(reservationId).transport_attempt_ids],
      observation_ids: [...this.#reservation(reservationId).observation_ids],
    }) : undefined;
  }

  availableAmount() {
    return amount(this.availableCents);
  }

  get effectiveChargeCount() {
    return this.effectiveChargeKeys.size;
  }

  #reservation(reservationId) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error(`unknown fixture reservation: ${reservationId}`);
    return reservation;
  }
}

function toCents(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value)) {
    throw new TypeError('fixture amounts must be exact two-place decimal strings');
  }
  const [whole, fraction] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
}

function amount(cents) {
  return {
    amount: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`,
    currency: 'USD',
  };
}
