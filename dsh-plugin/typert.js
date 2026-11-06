// Explicit strict Gateway descriptors. Browser calls use the same-origin DSH
// Connection transport; the Host validates every argument before dispatch.
import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const stringCodec = {
  mode: 'strict',
  typeSymbol: '@local/dsh-jmcomic#string',
  create: () => z.string(),
  jsonSchema: { type: 'string' },
};
const arg = name => ({ name, source: 'json', codec: stringCodec, strictCodec: stringCodec });
const method = names => ({
  service: 'jmcomic',
  invocation: { kind: 'direct' },
  parameters: names.map(arg),
  cancellation: { parameter: 'signal' },
  result: stringCodec,
});
export const remote = createTypertRemoteInfo({
  package: '@local/dsh-jmcomic',
  methods: {
    'jmcomic/search': method(['keyword', 'page']),
    'jmcomic/comic': method(['id']),
    'jmcomic/chapter': method(['id']),
    'jmcomic/cover': method(['id']),
    'jmcomic/readPage': method(['id', 'page']),
    'jmcomic/download': method(['id']),
  },
}, z);
export const TYPERT = {
  package: '@local/dsh-jmcomic', face: 'host', schemas: [],
  get invocations() { return remote.descriptors; },
  model: { services: [], events: [], objects: [] },
};
