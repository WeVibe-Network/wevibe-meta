import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export interface ScenarioResult {
    name: string;
    status: 'pass' | 'fail' | 'skip' | 'needs_infra';
    detail: string;
    duration_ms: number;
}

export class ScenarioRunner {
    private rl: readline.Interface;
    private results: ScenarioResult[] = [];
    private role: string;

    constructor(role: string) {
        this.role = role;
        this.rl = readline.createInterface({ input: stdin, output: stdout });
    }

    header() {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  WeVibe Test Suite — ${this.role} Mode`);
        console.log(`${'═'.repeat(60)}\n`);
    }

    async scenario(name: string, fn: () => Promise<string>): Promise<void> {
        const start = Date.now();
        console.log(`\n┌─ SCENARIO: ${name}`);
        console.log(`│`);
        try {
            const detail = await fn();
            const ms = Date.now() - start;
            this.results.push({ name, status: 'pass', detail, duration_ms: ms });
            console.log(`│`);
            console.log(`└─ ✅ PASS (${ms}ms) — ${detail}`);
        } catch (e) {
            const ms = Date.now() - start;
            const msg = e instanceof Error ? e.message : String(e);
            this.results.push({ name, status: 'fail', detail: msg, duration_ms: ms });
            console.log(`│`);
            console.log(`└─ ❌ FAIL (${ms}ms) — ${msg}`);
        }
    }

    async needsInfra(name: string, reason: string): Promise<void> {
        this.results.push({ name, status: 'needs_infra', detail: reason, duration_ms: 0 });
        console.log(`\n┌─ SCENARIO: ${name}`);
        console.log(`│  ⚠️  NEEDS INFRASTRUCTURE: ${reason}`);
        console.log(`└─ Skipped`);
    }

    print(msg: string) {
        console.log(`│  ${msg}`);
    }

    async confirm(prompt: string = 'Press Enter to continue...'): Promise<string> {
        return this.rl.question(`│  ${prompt} `);
    }

    async askYesNo(prompt: string): Promise<boolean> {
        const answer = await this.rl.question(`│  ${prompt} [y/n] `);
        return answer.trim().toLowerCase().startsWith('y');
    }

    async askInput(prompt: string): Promise<string> {
        return this.rl.question(`│  ${prompt}: `);
    }

    summary() {
        const pass = this.results.filter(r => r.status === 'pass').length;
        const fail = this.results.filter(r => r.status === 'fail').length;
        const skip = this.results.filter(r => r.status === 'skip').length;
        const infra = this.results.filter(r => r.status === 'needs_infra').length;

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  SUMMARY — ${this.role}`);
        console.log(`${'═'.repeat(60)}`);
        console.log(`  ✅ Pass: ${pass}`);
        console.log(`  ❌ Fail: ${fail}`);
        console.log(`  ⏭️  Skip: ${skip}`);
        console.log(`  ⚠️  Needs infra: ${infra}`);
        console.log(`${'═'.repeat(60)}\n`);

        if (fail > 0) {
            console.log('  FAILURES:');
            for (const r of this.results.filter(r => r.status === 'fail')) {
                console.log(`    - ${r.name}: ${r.detail}`);
            }
            console.log('');
        }

        if (infra > 0) {
            console.log('  NEEDS INFRASTRUCTURE:');
            for (const r of this.results.filter(r => r.status === 'needs_infra')) {
                console.log(`    - ${r.name}: ${r.detail}`);
            }
            console.log('');
        }

        return this.results;
    }

    close() { this.rl.close(); }
    getResults() { return this.results; }
}