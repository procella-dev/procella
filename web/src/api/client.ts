export interface StackInfo {
  orgName: string;
  projectName: string;
  stackName: string;
  tags: Record<string, string>;
  version: number;
  activeUpdate: string;
  currentOperation: string;
}

export interface UpdateInfo {
  kind: string;
  startTime: number;
  endTime: number;
  result: string;
  message: string;
  environment: Record<string, string>;
  config: Record<string, { value: string; secret: boolean }>;
  resourceChanges?: Record<string, number>;
  version: number;
}

export interface EngineEvent {
  sequence: number;
  timestamp: number;
  summaryEvent?: { resourceChanges: Record<string, number> };
  diagnosticEvent?: { severity: string; message: string };
  resourcePreEvent?: { metadata: { type: string; urn: string; op: string } };
  resOutputsEvent?: { metadata: { type: string; urn: string; op: string } };
  cancelEvent?: Record<string, unknown>;
}

export interface StacksResponse {
  stacks: StackInfo[];
}

export interface UpdatesResponse {
  updates: UpdateInfo[];
}

export interface LatestUpdateResponse {
  info: UpdateInfo;
}

export interface EventsResponse {
  events: EngineEvent[];
  continuationToken: string | null;
}

const getHeaders = () => {
  const token = localStorage.getItem('strata-token') || '';
  return {
    'Accept': 'application/vnd.pulumi+8',
    'Authorization': `token ${token}`,
  };
};

const API_BASE = '/api';

export const apiClient = {
  async getStacks(): Promise<StacksResponse> {
    const res = await fetch(`${API_BASE}/user/stacks`, { headers: getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch stacks: ${res.statusText}`);
    return res.json();
  },

  async getUpdates(org: string, project: string, stack: string, page = 1, pageSize = 20): Promise<UpdatesResponse> {
    const res = await fetch(`${API_BASE}/stacks/${org}/${project}/${stack}/updates?page=${page}&pageSize=${pageSize}`, { headers: getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch updates: ${res.statusText}`);
    return res.json();
  },

  async getLatestUpdate(org: string, project: string, stack: string): Promise<LatestUpdateResponse> {
    const res = await fetch(`${API_BASE}/stacks/${org}/${project}/${stack}/updates/latest`, { headers: getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch latest update: ${res.statusText}`);
    return res.json();
  },

  async getEvents(org: string, project: string, stack: string, updateID: string, continuationToken?: string): Promise<EventsResponse> {
    let url = `${API_BASE}/stacks/${org}/${project}/${stack}/update/${updateID}/events`;
    if (continuationToken) {
      url += `?continuationToken=${encodeURIComponent(continuationToken)}`;
    }
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch events: ${res.statusText}`);
    return res.json();
  }
};
