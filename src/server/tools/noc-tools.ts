// Tools exposed by the ISP/NOC support desk server.

import { toolResult, textError, type ToolDefinition } from '../core.js';
import {
  TICKETS,
  findMetrics,
  findOutagesByZone,
  findSubscriberByCircuit,
  findSubscribers,
  listZones,
  nextTicketId,
  type LinkMetrics,
  type Ticket,
} from '../data/noc-data.js';

const THRESHOLDS = {
  packetLossPct: { warn: 1, fail: 5 },
  latencyMs: { warn: 60, fail: 120 },
  jitterMs: { warn: 15, fail: 30 },
  snrDb: { warn: 20, fail: 15 },
} as const;

type Severity = 'ok' | 'degraded' | 'critical';

interface Finding {
  metric: string;
  value: number;
  threshold: number;
  severity: Severity;
  explanation: string;
}

function evaluate(metrics: LinkMetrics): { severity: Severity; findings: Finding[] } {
  const findings: Finding[] = [];

  if (metrics.packetLossPct >= 100) {
    findings.push({
      metric: 'packetLossPct',
      value: metrics.packetLossPct,
      threshold: THRESHOLDS.packetLossPct.fail,
      severity: 'critical',
      explanation: 'Total packet loss: the circuit is not passing traffic at all.',
    });
    return { severity: 'critical', findings };
  }

  const check = (
    metric: string,
    value: number,
    warn: number,
    fail: number,
    higherIsWorse: boolean,
    explanation: string,
  ) => {
    const failed = higherIsWorse ? value >= fail : value <= fail;
    const warned = higherIsWorse ? value >= warn : value <= warn;
    if (failed) findings.push({ metric, value, threshold: fail, severity: 'critical', explanation });
    else if (warned) findings.push({ metric, value, threshold: warn, severity: 'degraded', explanation });
  };

  check(
    'packetLossPct',
    metrics.packetLossPct,
    THRESHOLDS.packetLossPct.warn,
    THRESHOLDS.packetLossPct.fail,
    true,
    'Packet loss forces retransmissions, which users perceive as stalling and buffering.',
  );
  check(
    'latencyMs',
    metrics.latencyMs,
    THRESHOLDS.latencyMs.warn,
    THRESHOLDS.latencyMs.fail,
    true,
    'High round-trip time degrades interactive traffic such as calls and gaming.',
  );
  check(
    'jitterMs',
    metrics.jitterMs,
    THRESHOLDS.jitterMs.warn,
    THRESHOLDS.jitterMs.fail,
    true,
    'Variable delay breaks real-time audio and video even when average latency is acceptable.',
  );
  check(
    'snrDb',
    metrics.snrDb,
    THRESHOLDS.snrDb.warn,
    THRESHOLDS.snrDb.fail,
    false,
    'Low signal-to-noise ratio points at a physical-layer fault: a dirty connector, a bend, or a failing ONT.',
  );

  if (metrics.flapsLast24h >= 5) {
    findings.push({
      metric: 'flapsLast24h',
      value: metrics.flapsLast24h,
      threshold: 5,
      severity: 'degraded',
      explanation: 'Repeated link flaps usually accompany a physical or power fault at the customer end.',
    });
  }

  const severity: Severity = findings.some((f) => f.severity === 'critical')
    ? 'critical'
    : findings.length > 0
      ? 'degraded'
      : 'ok';

  return { severity, findings };
}

const lookupSubscriber: ToolDefinition = {
  name: 'lookup_subscriber',
  title: 'Look up a subscriber',
  description:
    'Find a subscriber account by name, subscriber id, circuit id or phone number. ' +
    'Returns the account details including the circuit id needed by the other tools. ' +
    'Always call this first when a caller is identified by name or phone.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Name, subscriber id (SUB-######), circuit id (GT-CIR-######) or phone number.',
      },
    },
    required: ['query'],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (args) => {
    const query = String(args['query']);
    const matches = findSubscribers(query);

    if (matches.length === 0) {
      return textError(
        `No subscriber matches "${query}". Try a subscriber id (SUB-######), a circuit id ` +
          `(GT-CIR-######), a full phone number, or part of the account holder's name.`,
      );
    }

    const lines = matches.map(
      (s) =>
        `${s.subscriberId} - ${s.name} | circuit ${s.circuitId} | zone ${s.zone} | ` +
        `plan ${s.plan.name} (${s.plan.downstreamMbps}/${s.plan.upstreamMbps} Mbps) | account ${s.accountStatus}`,
    );

    return toolResult(
      `Found ${matches.length} matching subscriber(s):\n${lines.join('\n')}`,
      { matches },
    );
  },
};

const getLinkMetrics: ToolDefinition = {
  name: 'get_link_metrics',
  title: 'Read live link telemetry',
  description:
    'Return the current telemetry for a circuit: latency, jitter, packet loss, signal-to-noise ' +
    'ratio, measured throughput, uptime and link flaps. Use the circuit id from lookup_subscriber.',
  inputSchema: {
    type: 'object',
    properties: {
      circuit_id: { type: 'string', description: 'Circuit identifier, e.g. GT-CIR-004821.' },
    },
    required: ['circuit_id'],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (args) => {
    const circuitId = String(args['circuit_id']);
    const metrics = findMetrics(circuitId);
    if (!metrics) return textError(`No telemetry found for circuit "${circuitId}".`);

    const subscriber = findSubscriberByCircuit(circuitId);
    const plan = subscriber?.plan;
    const downstreamPct = plan
      ? Math.round((metrics.measuredDownstreamMbps / plan.downstreamMbps) * 100)
      : undefined;

    const summary = [
      `Telemetry for ${metrics.circuitId} (${metrics.technology}):`,
      `  latency ............ ${metrics.latencyMs} ms`,
      `  jitter ............. ${metrics.jitterMs} ms`,
      `  packet loss ........ ${metrics.packetLossPct} %`,
      `  SNR ................ ${metrics.snrDb} dB`,
      `  downstream ......... ${metrics.measuredDownstreamMbps} Mbps` +
        (downstreamPct !== undefined ? ` (${downstreamPct}% of the ${plan?.downstreamMbps} Mbps plan)` : ''),
      `  upstream ........... ${metrics.measuredUpstreamMbps} Mbps`,
      `  uptime ............. ${metrics.uptimeHours} h`,
      `  flaps (24h) ........ ${metrics.flapsLast24h}`,
    ].join('\n');

    return toolResult(summary, { metrics, planDownstreamPct: downstreamPct });
  },
};

const runLinkDiagnostics: ToolDefinition = {
  name: 'run_link_diagnostics',
  title: 'Run a link diagnostic',
  description:
    'Evaluate a circuit against the operator thresholds and return a diagnosis, the findings ' +
    'that triggered it, and the recommended next action. Use this to decide whether a ticket ' +
    'is warranted before calling open_incident_ticket.',
  inputSchema: {
    type: 'object',
    properties: {
      circuit_id: { type: 'string', description: 'Circuit identifier, e.g. GT-CIR-004821.' },
    },
    required: ['circuit_id'],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (args) => {
    const circuitId = String(args['circuit_id']);
    const metrics = findMetrics(circuitId);
    if (!metrics) return textError(`No telemetry found for circuit "${circuitId}".`);

    const subscriber = findSubscriberByCircuit(circuitId);

    // An administratively suspended account looks like a fault but is not one.
    // Reporting it as a link problem would send a technician out for nothing.
    if (subscriber?.accountStatus === 'suspended') {
      return toolResult(
        `Diagnosis for ${circuitId}: NO FAULT. The physical link is healthy ` +
          `(SNR ${metrics.snrDb} dB, ${metrics.packetLossPct}% loss) but the account ` +
          `${subscriber.subscriberId} is SUSPENDED, so no traffic is forwarded. ` +
          `Recommended action: route the caller to billing; do not dispatch a technician.`,
        {
          circuitId,
          diagnosis: 'account-suspended',
          severity: 'ok',
          dispatchRecommended: false,
          findings: [],
        },
      );
    }

    const outages = findOutagesByZone(subscriber?.zone ?? '').filter((o) => o.status !== 'resolved');
    const { severity, findings } = evaluate(metrics);

    // A known zone outage explains the symptom and supersedes a per-link fault.
    if (outages.length > 0 && severity === 'critical') {
      const outage = outages[0]!;
      return toolResult(
        `Diagnosis for ${circuitId}: OUTAGE. The circuit is affected by known incident ` +
          `${outage.outageId} in ${outage.zone} (${outage.cause}), status ${outage.status}, ` +
          `estimated resolution ${outage.estimatedResolution}. ` +
          `Recommended action: inform the caller of the ETA and do NOT open a duplicate ticket.`,
        {
          circuitId,
          diagnosis: 'zone-outage',
          severity,
          dispatchRecommended: false,
          outage,
          findings,
        },
      );
    }

    if (severity === 'ok') {
      return toolResult(
        `Diagnosis for ${circuitId}: HEALTHY. All metrics are within thresholds ` +
          `(loss ${metrics.packetLossPct}%, latency ${metrics.latencyMs} ms, SNR ${metrics.snrDb} dB). ` +
          `Recommended action: check the customer's own equipment (Wi-Fi, cabling) before escalating.`,
        { circuitId, diagnosis: 'healthy', severity, dispatchRecommended: false, findings },
      );
    }

    const findingLines = findings.map(
      (f) => `  - ${f.metric} = ${f.value} (threshold ${f.threshold}, ${f.severity}): ${f.explanation}`,
    );

    return toolResult(
      `Diagnosis for ${circuitId}: ${severity.toUpperCase()} link fault.\n` +
        `${findingLines.join('\n')}\n` +
        `Recommended action: ${
          severity === 'critical'
            ? 'open a high-severity incident ticket and dispatch a field technician.'
            : 'open a medium-severity ticket for remote investigation.'
        }`,
      {
        circuitId,
        diagnosis: 'link-fault',
        severity,
        dispatchRecommended: severity === 'critical',
        findings,
      },
    );
  },
};

const checkZoneOutage: ToolDefinition = {
  name: 'check_zone_outage',
  title: 'Check for outages in a zone',
  description:
    'List known network incidents affecting a service zone, with cause, status and estimated ' +
    'resolution time. Call this before opening a ticket so that a subscriber affected by a ' +
    'known outage does not generate a duplicate.',
  inputSchema: {
    type: 'object',
    properties: {
      zone: {
        type: 'string',
        description: `Service zone identifier, e.g. ZONA-GUATE-07. Known zones: ${listZones().join(', ')}.`,
      },
    },
    required: ['zone'],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (args) => {
    const zone = String(args['zone']);
    const outages = findOutagesByZone(zone);

    if (outages.length === 0) {
      return toolResult(`No recorded incidents for zone "${zone}". Known zones: ${listZones().join(', ')}.`, {
        zone,
        outages: [],
      });
    }

    const lines = outages.map(
      (o) =>
        `${o.outageId} [${o.status}] ${o.zone}: ${o.cause}. Started ${o.startedAt}, ` +
        `ETA ${o.estimatedResolution}, ${o.affectedSubscribers} subscribers affected.`,
    );

    return toolResult(`Incidents for "${zone}":\n${lines.join('\n')}`, { zone, outages });
  },
};

const openIncidentTicket: ToolDefinition = {
  name: 'open_incident_ticket',
  title: 'Open an incident ticket',
  description:
    'Escalate a subscriber issue by creating an incident ticket. Only call this after ' +
    'run_link_diagnostics indicates a fault and check_zone_outage shows no known incident ' +
    'already covers it. Returns the ticket id to read back to the caller.',
  inputSchema: {
    type: 'object',
    properties: {
      subscriber_id: { type: 'string', description: 'Subscriber identifier, e.g. SUB-100482.' },
      summary: { type: 'string', description: 'One-line description of the fault and its evidence.' },
      severity: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Ticket severity.',
      },
    },
    required: ['subscriber_id', 'summary', 'severity'],
  },
  // Creates state on the operator side: not read-only, but not destructive either.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: (args) => {
    const subscriberId = String(args['subscriber_id']);
    const summary = String(args['summary']);
    const severity = String(args['severity']) as Ticket['severity'];

    const matches = findSubscribers(subscriberId);
    const subscriber = matches.find((s) => s.subscriberId.toLowerCase() === subscriberId.toLowerCase());
    if (!subscriber) {
      return textError(
        `Cannot open a ticket: no subscriber with id "${subscriberId}". ` +
          `Call lookup_subscriber first to obtain the exact subscriber id.`,
      );
    }

    const assignedTeam =
      severity === 'critical' || severity === 'high' ? 'Field Operations' : 'Remote NOC Tier 2';

    const ticket: Ticket = {
      ticketId: nextTicketId(),
      subscriberId: subscriber.subscriberId,
      summary,
      severity,
      status: 'open',
      createdAt: new Date().toISOString(),
      assignedTeam,
    };
    TICKETS.push(ticket);

    return toolResult(
      `Ticket ${ticket.ticketId} opened for ${subscriber.name} (${subscriber.subscriberId}), ` +
        `severity ${ticket.severity}, assigned to ${ticket.assignedTeam}. Summary: ${ticket.summary}`,
      { ticket },
    );
  },
};

export const NOC_TOOLS: ToolDefinition[] = [
  lookupSubscriber,
  getLinkMetrics,
  runLinkDiagnostics,
  checkZoneOutage,
  openIncidentTicket,
];

export { THRESHOLDS };
