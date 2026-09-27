#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevAgreement } from '../src/core/services/jev-agreement.mjs';
const report = jevAgreement({ root: process.env.MAILBOARD_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
console.log(JSON.stringify(report));
