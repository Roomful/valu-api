// ===========================================================================
// LLM tool definitions, generated from the descriptors.
//
// The server hands the model `{type: 'function', function: {name, description,
// parameters}}` pairs. Producing them from the descriptor means a tool's
// schema and the validator that enforces it cannot drift apart — they are the
// same declaration read twice.
// ===========================================================================
import { listDescriptors } from './descriptors.js';

const JSON_TYPES = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  object: { type: 'object' },
  array: { type: 'array' },
  'string[]': { type: 'array', items: { type: 'string' } },
  'object[]': { type: 'array', items: { type: 'object' } },
  FileList: { type: 'array', items: { type: 'string' } },
};

function jsonSchemaFor(param) {
  const schema = { ...(JSON_TYPES[param.type] ?? { type: 'string' }) };
  if (param.description) schema.description = param.description;
  if (param.options) schema.enum = [...param.options];
  return schema;
}

/**
 * One tool definition for a descriptor.
 * @param {import('./descriptors.js').ServiceDescriptor} descriptor
 */
export function toolDefinition(descriptor) {
  const properties = {};
  for (const param of [...descriptor.params.required, ...descriptor.params.optional]) {
    properties[param.name] = jsonSchemaFor(param);
  }
  return {
    type: 'function',
    function: {
      name: descriptor.toolName,
      description: descriptor.description,
      parameters: {
        type: 'object',
        properties,
        ...(descriptor.params.required.length
          ? { required: descriptor.params.required.map((p) => p.name) }
          : {}),
        additionalProperties: false,
      },
    },
  };
}

/**
 * Tool definitions for the catalogue.
 *
 * Defaults to what an AI caller may actually reach: functions declared
 * `availability: ['ai']` that are not host-bound. Pass filters through to
 * widen or narrow it.
 * @param {{service?: string, binding?: string, availability?: string|null, mutates?: boolean}} [filter]
 */
export function toolDefinitions(filter = {}) {
  const { availability = 'ai', ...rest } = filter;
  return listDescriptors({ ...rest, ...(availability ? { availability } : {}) })
    .filter((d) => (rest.binding ? true : d.binding !== 'host'))
    .map(toolDefinition);
}
