// Synthetic dataset for the NOC support desk. No real subscriber data.

export type ServiceTechnology = 'GPON' | 'DOCSIS-3.1' | 'FTTH' | 'Fixed-Wireless';

export interface ServicePlan {
  name: string;
  downstreamMbps: number;
  upstreamMbps: number;
}

export interface Subscriber {
  subscriberId: string;
  name: string;
  phone: string;
  address: string;
  zone: string;
  plan: ServicePlan;
  circuitId: string;
  accountStatus: 'active' | 'suspended' | 'pending-activation';
}

export interface LinkMetrics {
  circuitId: string;
  technology: ServiceTechnology;
  latencyMs: number;
  jitterMs: number;
  packetLossPct: number;
  snrDb: number;
  measuredDownstreamMbps: number;
  measuredUpstreamMbps: number;
  uptimeHours: number;
  flapsLast24h: number;
}

export interface Outage {
  outageId: string;
  zone: string;
  cause: string;
  startedAt: string;
  estimatedResolution: string;
  affectedSubscribers: number;
  status: 'investigating' | 'identified' | 'repair-in-progress' | 'resolved';
}

export interface Ticket {
  ticketId: string;
  subscriberId: string;
  summary: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'assigned' | 'resolved';
  createdAt: string;
  assignedTeam: string;
}

export const SUBSCRIBERS: Subscriber[] = [
  {
    subscriberId: 'SUB-100482',
    name: 'Maria Elena Ramirez',
    phone: '+502 5512-8834',
    address: '4a Calle 12-45, Zona 1, Mixco',
    zone: 'ZONA-MIXCO-03',
    plan: { name: 'Fibra Hogar 300', downstreamMbps: 300, upstreamMbps: 150 },
    circuitId: 'GT-CIR-004821',
    accountStatus: 'active',
  },
  {
    subscriberId: 'SUB-100731',
    name: 'Carlos Humberto Divas',
    phone: '+502 4478-1120',
    address: '7a Avenida 3-18, Zona 10, Guatemala',
    zone: 'ZONA-GUATE-10',
    plan: { name: 'Fibra Hogar 600', downstreamMbps: 600, upstreamMbps: 300 },
    circuitId: 'GT-CIR-005190',
    accountStatus: 'active',
  },
  {
    subscriberId: 'SUB-100955',
    name: 'Ana Lucia Estrada',
    phone: '+502 3390-7745',
    address: 'Calzada Roosevelt 22-10, Zona 7, Guatemala',
    zone: 'ZONA-GUATE-07',
    plan: { name: 'Fibra Negocio 1000', downstreamMbps: 1000, upstreamMbps: 500 },
    circuitId: 'GT-CIR-005544',
    accountStatus: 'active',
  },
  {
    subscriberId: 'SUB-101204',
    name: 'Jorge Antonio Similox',
    phone: '+502 5860-2291',
    address: '2a Calle 8-30, Antigua Guatemala',
    zone: 'ZONA-SACATEPEQUEZ-01',
    plan: { name: 'Fibra Hogar 150', downstreamMbps: 150, upstreamMbps: 75 },
    circuitId: 'GT-CIR-006012',
    accountStatus: 'suspended',
  },
  {
    subscriberId: 'SUB-101488',
    name: 'Sofia Renata Marroquin',
    phone: '+502 4102-6673',
    address: 'Boulevard Vista Hermosa 15-22, Zona 15, Guatemala',
    zone: 'ZONA-GUATE-15',
    plan: { name: 'Fibra Hogar 300', downstreamMbps: 300, upstreamMbps: 150 },
    circuitId: 'GT-CIR-006377',
    accountStatus: 'active',
  },
];

export const LINK_METRICS: LinkMetrics[] = [
  {
    // Degraded: heavy packet loss and a poor SNR - the main demo path.
    circuitId: 'GT-CIR-004821',
    technology: 'GPON',
    latencyMs: 48,
    jitterMs: 19.4,
    packetLossPct: 8.2,
    snrDb: 14.1,
    measuredDownstreamMbps: 62,
    measuredUpstreamMbps: 41,
    uptimeHours: 6,
    flapsLast24h: 11,
  },
  {
    // Healthy link, used to show the assistant clearing a subscriber.
    circuitId: 'GT-CIR-005190',
    technology: 'FTTH',
    latencyMs: 9,
    jitterMs: 1.2,
    packetLossPct: 0,
    snrDb: 33.8,
    measuredDownstreamMbps: 588,
    measuredUpstreamMbps: 296,
    uptimeHours: 742,
    flapsLast24h: 0,
  },
  {
    // Inside an active zone outage: the link is simply down.
    circuitId: 'GT-CIR-005544',
    technology: 'FTTH',
    latencyMs: 0,
    jitterMs: 0,
    packetLossPct: 100,
    snrDb: 0,
    measuredDownstreamMbps: 0,
    measuredUpstreamMbps: 0,
    uptimeHours: 0,
    flapsLast24h: 3,
  },
  {
    // Suspended account: the physical link is fine, service is administratively off.
    circuitId: 'GT-CIR-006012',
    technology: 'GPON',
    latencyMs: 12,
    jitterMs: 2.1,
    packetLossPct: 0,
    snrDb: 31.2,
    measuredDownstreamMbps: 0,
    measuredUpstreamMbps: 0,
    uptimeHours: 210,
    flapsLast24h: 0,
  },
  {
    // High latency and jitter with no loss - congestion rather than a fault.
    circuitId: 'GT-CIR-006377',
    technology: 'Fixed-Wireless',
    latencyMs: 137,
    jitterMs: 42.6,
    packetLossPct: 0.4,
    snrDb: 22.7,
    measuredDownstreamMbps: 108,
    measuredUpstreamMbps: 63,
    uptimeHours: 96,
    flapsLast24h: 1,
  },
];

export const OUTAGES: Outage[] = [
  {
    outageId: 'OUT-2291',
    zone: 'ZONA-GUATE-07',
    cause: 'Fiber cut caused by roadworks on Calzada Roosevelt',
    startedAt: '2026-08-19T11:20:00-06:00',
    estimatedResolution: '2026-08-19T18:00:00-06:00',
    affectedSubscribers: 1834,
    status: 'repair-in-progress',
  },
  {
    outageId: 'OUT-2288',
    zone: 'ZONA-SACATEPEQUEZ-01',
    cause: 'Scheduled OLT firmware upgrade',
    startedAt: '2026-08-19T02:00:00-06:00',
    estimatedResolution: '2026-08-19T05:00:00-06:00',
    affectedSubscribers: 412,
    status: 'resolved',
  },
];

export const TICKETS: Ticket[] = [];

let ticketCounter = 4400;

export function nextTicketId(): string {
  ticketCounter += 1;
  return `TCK-${ticketCounter}`;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    // NFD splits accented letters into a base letter plus a combining mark, and
    // the filter below drops the marks along with punctuation and spaces. That
    // makes lookups accent- and format-insensitive, so a search for "Lucia"
    // matches "Lucia", and "55128834" matches "+502 5512-8834".
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '');
}

export function findSubscribers(query: string): Subscriber[] {
  const needle = normalize(query);
  if (needle.length === 0) return [];

  return SUBSCRIBERS.filter((subscriber) => {
    return (
      normalize(subscriber.subscriberId).includes(needle) ||
      normalize(subscriber.circuitId).includes(needle) ||
      normalize(subscriber.phone).includes(needle) ||
      normalize(subscriber.name).includes(needle)
    );
  });
}

export function findMetrics(circuitId: string): LinkMetrics | undefined {
  const needle = normalize(circuitId);
  return LINK_METRICS.find((metrics) => normalize(metrics.circuitId) === needle);
}

export function findSubscriberByCircuit(circuitId: string): Subscriber | undefined {
  const needle = normalize(circuitId);
  return SUBSCRIBERS.find((subscriber) => normalize(subscriber.circuitId) === needle);
}

export function findOutagesByZone(zone: string): Outage[] {
  const needle = normalize(zone);
  return OUTAGES.filter((outage) => normalize(outage.zone).includes(needle));
}

export function listZones(): string[] {
  return [...new Set(SUBSCRIBERS.map((subscriber) => subscriber.zone))].sort();
}
