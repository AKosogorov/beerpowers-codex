#!/usr/bin/env node
// Формирует бюджет команды и распределяет ограничения между ролями.
import {readFileSync} from 'node:fs';

import { showHelp } from './lib/cli-help.mjs';

showHelp('team-economy.mjs < economy.json');

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const {economy, files, largeDiff, sharedComponent, invariant, critical, independentReview, phases} = input;
  const flags = [economy, largeDiff, sharedComponent, invariant, critical, independentReview];
  if (flags.some(flag => typeof flag !== 'boolean') || !Number.isSafeInteger(files) || files < 0 ||
      !Array.isArray(phases) || phases.some(phase => !phase || typeof phase.name !== 'string' || !phase.name ||
        (phase.stopAfter !== undefined && typeof phase.stopAfter !== 'boolean') ||
        (phase.requests != null && (!Number.isSafeInteger(phase.requests) || phase.requests < 0))) ||
      new Set(phases.map(phase => phase.name)).size !== phases.length) throw Error('Invalid economy decision input');
  const localReview = economy && files === 1 && !largeDiff && !sharedComponent && !invariant && !critical && !independentReview;
  const runs = [];
  for (let i = 0; i < phases.length; i++) {
    const current = phases[i];
    const next = phases[i + 1];
    const canPair = economy && next && !current.stopAfter && current.requests != null && current.requests <= 70 &&
      next.requests != null && next.requests <= 70;
    runs.push(canPair ? [current.name, phases[++i].name] : [current.name]);
  }
  console.log(JSON.stringify({reviewBy:localReview ? 'team-lead' : 'reviewer', runs}));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
