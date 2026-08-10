export interface EntityTags {
  domain?: string;
  region?: string;
  system?: string;
}

const KEYWORD_MAP = {
  domain: {
    Payment: ['invoice', 'billing', 'payment', 'transaction', 'credit_card'],
    User: ['user', 'account', 'profile', 'auth', 'session'],
    Order: ['order', 'cart', 'shipping', 'inventory', 'sku'],
  },
  region: {
    'US-East': ['us-east', 'virginia', 'ashburn'],
    'EU-West': ['eu-west', 'ireland', 'dublin'],
  },
  system: {
    Legacy: ['legacy', 'mainframe', 'v1', 'old_'],
    Cloud: ['cloud', 'aws', 'azure', 'gcp', 'k8s'],
  },
};

export function tagEntity(name: string): EntityTags {
  const tags: EntityTags = {};
  const normalizedName = name.toLowerCase().replace(/_/g, '-');

  for (const [domain, keywords] of Object.entries(KEYWORD_MAP.domain)) {
    if (keywords.some(k => normalizedName.includes(k.toLowerCase()))) {
      tags.domain = domain;
      break;
    }
  }
  for (const [region, keywords] of Object.entries(KEYWORD_MAP.region)) {
    if (keywords.some(k => normalizedName.includes(k.toLowerCase()))) {
      tags.region = region;
      break;
    }
  }
  for (const [system, keywords] of Object.entries(KEYWORD_MAP.system)) {
    if (keywords.some(k => normalizedName.includes(k.toLowerCase()))) {
      tags.system = system;
      break;
    }
  }

  return tags;
}
