/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { TriggerResponse, InitResponse } from './TemplateArchiveProcessor';

/**
 * Configuration for the LLM provider.
 * Passed in by the caller — no hardcoded keys anywhere in this file.
 */
export type LLMConfig = {
    apiKey: string;          // e.g. process.env.ANTHROPIC_API_KEY
    model: string;           // e.g. 'claude-sonnet-4-20250514' or 'gpt-4o'
    provider: 'anthropic' | 'openai';
    maxTokens?: number;      // defaults to 1024
};

/**
 * Input to the LLM trigger call — mirrors what TemplateArchiveProcessor.trigger() receives.
 */
export type LLMTriggerRequest = {
    contractText: string;    // the full natural language contract text
    contractData: any;       // the filled contract variables (JSON)
    request: any;            // the incoming transaction (Concerto typed JSON)
    state: any;              // current contract state (JSON)
    currentTime?: string;
};

/**
 * Input to the LLM init call.
 */
export type LLMInitRequest = {
    contractText: string;
    contractData: any;
    currentTime?: string;
};

/**
 * Builds the system prompt that tells the LLM what role it plays.
 * Keeping this separate makes it easy to iterate on prompt quality.
 */
function buildSystemPrompt(): string {
    return `You are a contract logic executor for the Accord Project.
You receive a legal contract and must evaluate its logic precisely.
You always respond with valid JSON only — no explanation, no markdown, no code fences.
Never add fields that were not requested. Never omit required fields.`;
}

/**
 * Builds the trigger prompt.
 * The LLM must return a JSON object matching TriggerResponse exactly.
 */
function buildTriggerPrompt(req: LLMTriggerRequest): string {
    return `CONTRACT TEXT:
${req.contractText}

CONTRACT DATA (variables):
${JSON.stringify(req.contractData, null, 2)}

CURRENT STATE:
${JSON.stringify(req.state, null, 2)}

INCOMING REQUEST/TRANSACTION:
${JSON.stringify(req.request, null, 2)}

CURRENT TIME: ${req.currentTime ?? new Date().toISOString()}

Evaluate the contract logic for this request and return a JSON object with exactly these fields:
{
  "result": { ... },   // the response object
  "state": { ... },    // the updated contract state
  "events": [ ... ]    // array of emitted events (can be empty array)
}`;
}

/**
 * Builds the init prompt.
 * The LLM must return a JSON object matching InitResponse exactly.
 */
function buildInitPrompt(req: LLMInitRequest): string {
    return `CONTRACT TEXT:
${req.contractText}

CONTRACT DATA (variables):
${JSON.stringify(req.contractData, null, 2)}

CURRENT TIME: ${req.currentTime ?? new Date().toISOString()}

Initialize this contract and return a JSON object with exactly this field:
{
  "state": { ... }   // the initial contract state
}`;
}

/**
 * Calls the Anthropic Messages API.
 * Returns the parsed JSON response from the LLM.
 */
async function callAnthropic(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<any> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: config.maxTokens ?? 1024,
            system: systemPrompt,
            messages: [
                { role: 'user', content: userPrompt }
            ]
        })
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    const body = await response.json() as any;
    // body.content is an array of blocks; the first text block is the JSON response
    const textBlock = body.content?.find((b: any) => b.type === 'text');
    if (!textBlock) {
        throw new Error('No text block in Anthropic response');
    }
    return JSON.parse(textBlock.text);
}

/**
 * Calls the OpenAI Chat Completions API.
 * Returns the parsed JSON response from the LLM.
 */
async function callOpenAI(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<any> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: config.maxTokens ?? 1024,
            response_format: { type: 'json_object' }, // forces JSON output
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        })
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${err}`);
    }

    const body = await response.json() as any;
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('No content in OpenAI response');
    }
    return JSON.parse(content);
}

/**
 * Routes the LLM call to the correct provider.
 */
async function callLLM(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<any> {
    if (config.provider === 'anthropic') {
        return callAnthropic(config, systemPrompt, userPrompt);
    } else if (config.provider === 'openai') {
        return callOpenAI(config, systemPrompt, userPrompt);
    }
    throw new Error(`Unsupported LLM provider: ${config.provider}`);
}

/**
 * Validates that a trigger response has the required shape.
 * Throws if malformed — better to fail loudly than silently return bad data.
 */
function validateTriggerResponse(raw: any): TriggerResponse {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('LLM trigger response is not an object');
    }
    if (!('result' in raw)) throw new Error('LLM trigger response missing "result"');
    if (!('state' in raw)) throw new Error('LLM trigger response missing "state"');
    if (!Array.isArray(raw.events)) throw new Error('LLM trigger response "events" must be an array');
    return raw as TriggerResponse;
}

/**
 * Validates that an init response has the required shape.
 */
function validateInitResponse(raw: any): InitResponse {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('LLM init response is not an object');
    }
    if (!('state' in raw)) throw new Error('LLM init response missing "state"');
    return raw as InitResponse;
}

/**
 * Executes contract logic using an LLM instead of compiled TypeScript.
 * This is the fallback path when no logic file is present in the template archive.
 */
export class LLMEvaluator {
    private config: LLMConfig;

    constructor(config: LLMConfig) {
        this.config = config;
    }

    /**
     * Runs the trigger function via LLM reasoning.
     */
    async trigger(contractText: string, req: LLMTriggerRequest): Promise<TriggerResponse> {
        const system = buildSystemPrompt();
        const user = buildTriggerPrompt(req);
        const raw = await callLLM(this.config, system, user);
        return validateTriggerResponse(raw);
    }

    /**
     * Runs the init function via LLM reasoning.
     */
    async init(contractText: string, req: LLMInitRequest): Promise<InitResponse> {
        const system = buildSystemPrompt();
        const user = buildInitPrompt(req);
        const raw = await callLLM(this.config, system, user);
        return validateInitResponse(raw);
    }
}