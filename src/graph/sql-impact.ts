import type Database from 'better-sqlite3';
import { ProjectedGraph } from './projection.js';
import { tagEntity, type EntityTags } from '../parser/tagger.js';

export interface ImpactResult {
  tableName: string;
  affectedQueries: { id: number; file: string }[];
  affectedFiles: string[];
  affectedServices: string[];
}

export function getImpact(
  graph: ProjectedGraph,
  tableName: string,
  filters: EntityTags = {}
): ImpactResult {
  const result: ImpactResult = {
    tableName,
    affectedQueries: [],
    affectedFiles: [],
    affectedServices: [],
  };

  const tags = tagEntity(tableName);
  if (
    (filters.domain && tags.domain !== filters.domain) ||
    (filters.region && tags.region !== filters.region) ||
    (filters.system && tags.system !== filters.system)
  ) {
    return result;
  }

  const queryIds = graph.tables.get(tableName);
  if (!queryIds) return result;

  const files = new Set<string>();
  const services = new Set<string>();

  for (const qId of queryIds) {
    const filePath = graph.queries.get(qId);
    if (filePath) {
      result.affectedQueries.push({ id: qId, file: filePath });
      files.add(filePath);

      const service = graph.files.get(filePath);
      if (service) {
        services.add(service);
      }
    }
  }

  result.affectedFiles = Array.from(files);
  result.affectedServices = Array.from(services);

  return result;
}

export function findParallelStorage(
  graph: ProjectedGraph,
  filters: EntityTags = {}
): { tableName: string; systems: string[] }[] {
  // Heuristic: in this simplified project, we look at the paths of the files
  // containing the queries for a table to infer the system.
  // In a real project, this would likely be a separate table in the DB.

  const results: { tableName: string; systems: string[] }[] = [];

  for (const [tableName, queryIds] of graph.tables.entries()) {
    const tags = tagEntity(tableName);
    if (
      (filters.domain && tags.domain !== filters.domain) ||
      (filters.region && tags.region !== filters.region) ||
      (filters.system && tags.system !== filters.system)
    ) {
      continue;
    }

    const systems = new Set<string>();
    for (const qId of queryIds) {
      const path = graph.queries.get(qId) || '';
      if (path.includes('mongo')) {
        systems.add('mongodb');
      } else if (path.includes('Service') || path.includes('Repository') || path.includes('sql')) {
        systems.add('sql');
      } else {
        systems.add('unknown');
      }
    }

    if (systems.size > 1) {
      results.push({ tableName, systems: Array.from(systems) });
    }
  }

  return results;
}
