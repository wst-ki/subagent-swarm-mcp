import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { validateSchema, validateValue, structuredPrompt, evaluateStructuredResult, readSchemaFromDb, readContractFromDb, SECTION_OUTLINE_SCHEMA, SECTION_OUTLINE_MICROBATCH_SCHEMA } from '../src/structured.mjs';

const schema = { type:'object', additionalProperties:false, required:['paper_id','sections'], properties:{
  paper_id:{type:'string',minLength:1}, sections:{type:'array',minItems:1,maxItems:3,items:{type:'object',additionalProperties:false,required:['level','title'],properties:{level:{type:'integer',minimum:1,maximum:3},title:{type:'string'}}}}
} };

test('schema checks and structured prompt preserve one recoverable contract', () => {
  assert.equal(validateSchema(schema),schema);
  const prompt=structuredPrompt({task:'Find sections',input:{paper_id:'p1',text:'Introduction'},schema});
  assert.deepEqual(JSON.parse(prompt.split('\n')[0].slice('ZCODE_STRUCTURED_V1 '.length)),schema);
  assert.throws(()=>validateSchema({...schema,pattern:'.*'}),/Unsupported schema keyword/);
  assert.throws(()=>validateSchema({type:'object',properties:{}}),/additionalProperties/);
  assert.throws(()=>validateSchema({type:'array',items:{type:'string'}}),/Root schema/);
});
test('validator rejects missing, unexpected, out of range and wrong types', () => {
  assert.deepEqual(validateValue(schema,{paper_id:'p1',sections:[{level:1,title:'Introduction'}]}),[]);
  const errors=validateValue(schema,{paper_id:'',sections:[{level:4,title:12,extra:1}]});
  assert.equal(errors.length,4);
  assert.ok(validateValue(schema,{paper_id:'p1'}).some(e=>e.includes('required')));
});
test('only completed schema-valid single JSON answer succeeds', () => {
  const check = (status,result) => evaluateStructuredResult('session_x',schema,{status,result});
  assert.equal(check('running','').structuredStatus,'pending');
  assert.equal(check('failed','{"paper_id":"p","sections":[]}').structuredStatus,'task_not_completed');
  assert.equal(check('completed','```json\n{}\n```').structuredStatus,'invalid');
  assert.equal(check('completed','{"paper_id":"p","sections":[]}').structuredStatus,'invalid');
  assert.equal(check('completed','{"paper_id":"p","sections":[{"level":1,"title":"Introduction"}]}').structuredStatus,'valid');
  assert.equal(evaluateStructuredResult('session_x',schema,{status:'failed',error:{code:'429'}}).failureKind,'quota_or_rate_limit');
  assert.equal(check('completed','x'.repeat(262145)).structuredStatus,'invalid');
});
test('contract is recovered from the matching session and follow-ups fail closed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table message (id text,session_id text,data text,time_created integer,sequence integer); create table part (message_id text,session_id text,data text,sequence integer)');
    const add = (id,sid,text,time) => {
      db.prepare('insert into message values (?,?,?,?,?)').run(id,sid,JSON.stringify({role:'user'}),time,0);
      db.prepare('insert into part values (?,?,?,?)').run(id,sid,JSON.stringify({type:'text',text}),0);
    };
    add('m1','session_1',structuredPrompt({task:'x',input:{expected:[1,2]},schema:SECTION_OUTLINE_SCHEMA,domainRule:'section-outline-v1'}),1);
    add('m2','session_2','ordinary prompt',2);
    assert.deepEqual(readSchemaFromDb(db,'session_1'),SECTION_OUTLINE_SCHEMA);
    const contract = readContractFromDb(db,'session_1');
    assert.equal(contract.domainRule,'section-outline-v1');
    assert.deepEqual(contract.input,{expected:[1,2]});
    assert.throws(()=>readSchemaFromDb(db,'session_2'),/does not contain/);
    add('m3','session_1','follow-up',3);
    assert.throws(()=>readSchemaFromDb(db,'session_1'),/multiple user messages/);
  } finally { db.close(); }
});
test('domain validator section-outline-v1 checks ID coverage, title level, and level jumps', () => {
  const input = { expected: [1, 2, 3] };
  const validAns = JSON.stringify({
    labels: [
      { i: 1, level: 1, role: 'title', conf: 1 },
      { i: 2, level: 1, role: 'introduction', conf: 0.9 },
      { i: 3, level: 2, role: 'methods', conf: 0.9 },
    ],
  });
  assert.equal(evaluateStructuredResult('s1', SECTION_OUTLINE_SCHEMA, { status: 'completed', result: validAns }, { domainRule: 'section-outline-v1', input }).structuredStatus, 'valid');

  const missingId = JSON.stringify({
    labels: [
      { i: 1, level: 1, role: 'title', conf: 1 },
      { i: 2, level: 1, role: 'introduction', conf: 0.9 },
    ],
  });
  const rMissing = evaluateStructuredResult('s1', SECTION_OUTLINE_SCHEMA, { status: 'completed', result: missingId }, { domainRule: 'section-outline-v1', input });
  assert.equal(rMissing.structuredStatus, 'invalid');
  assert.ok(rMissing.errors.some(e => e.includes('missing expected heading id 3')));

  const levelJump = JSON.stringify({
    labels: [
      { i: 1, level: 1, role: 'title', conf: 1 },
      { i: 2, level: 3, role: 'introduction', conf: 0.9 },
      { i: 3, level: 2, role: 'methods', conf: 0.9 },
    ],
  });
  const rJump = evaluateStructuredResult('s1', SECTION_OUTLINE_SCHEMA, { status: 'completed', result: levelJump }, { domainRule: 'section-outline-v1', input });
  assert.equal(rJump.structuredStatus, 'invalid');
  assert.ok(rJump.errors.some(e => e.includes('level jump')));
});
test('domain validator section-outline-microbatch-v1 validates multi-document microbatches', () => {
  const input = {
    documents: [
      { document_id: 'doc1', expected: [1, 2] },
      { document_id: 'doc2', expected: [1] },
    ],
  };
  const validAns = JSON.stringify({
    documents: [
      { document_id: 'doc1', labels: [{ i: 1, level: 1, role: 'title', conf: 1 }, { i: 2, level: 1, role: 'references', conf: 0.95 }] },
      { document_id: 'doc2', labels: [{ i: 1, level: 1, role: 'title', conf: 1 }] },
    ],
  });
  assert.equal(evaluateStructuredResult('s2', SECTION_OUTLINE_MICROBATCH_SCHEMA, { status: 'completed', result: validAns }, { domainRule: 'section-outline-microbatch-v1', input }).structuredStatus, 'valid');
});
