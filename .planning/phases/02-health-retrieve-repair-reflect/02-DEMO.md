[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.onlyBuiltDependencies". See https://pnpm.io/settings for the new home of each setting.
[selfcheck] getHealth: {
  "score": 67,
  "dimensions": {
    "freshness": 1,
    "consistency": 0.6666666666666667,
    "coverage": 0.25,
    "confidence": 0.5833333333333334
  },
  "issues": [
    {
      "type": "broken_import",
      "message": "unresolved import: ./missing",
      "location": "src/c.ts"
    },
    {
      "type": "low_coverage",
      "message": "coverage below 50%"
    }
  ]
}
[selfcheck] retrieve("auth"): [
  {
    "path": "src/with-comments.ts",
    "score": 0.6432790648648986,
    "symbols": [
      {
        "name": "auth",
        "kind": "function",
        "startLine": 2,
        "endLine": 4,
        "exported": true
      }
    ],
    "summary": "export function auth(): number {"
  }
]
[selfcheck] repair: {
  "stages": [
    {
      "ok": true,
      "actions": [
        "no changes; rebuild was a no-op"
      ]
    },
    {
      "ok": true,
      "actions": [
        "invalidated 0 cache entries"
      ]
    },
    {
      "ok": false,
      "actions": [
        "no .git directory; stage 3 skipped"
      ]
    }
  ]
}
[selfcheck] getHealth after signal: {
  "score": 77,
  "dimensions": {
    "freshness": 1,
    "consistency": 0.6666666666666667,
    "coverage": 0.5,
    "confidence": 0.8333333333333334
  },
  "issues": [
    {
      "type": "broken_import",
      "message": "unresolved import: ./missing",
      "location": "src/c.ts"
    }
  ]
}
