import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultBuild } from '../calc.mjs';
import { prepareTeam } from '../team.mjs';
import { pointAt, simulateTactic } from '../tactic.mjs';
import { exCost, removeSkill, rotateSkill, skillDeck } from '../rules.mjs';
import { tacticInputStamp } from '../tactic-ui.mjs';

const data=JSON.parse(await readFile(new URL('../data/global.json',import.meta.url),'utf8'));
const member=id=>{const student=data.students.find(s=>s.Id===id);return {student,build:defaultBuild(student,data.meta.region)};};
const phases=[{name:'target',hp:1e9,enemy:{level:1,defense:0,armor:'LightArmor',terrain:'Street',critResist:100,critDmgResist:50,evasion:0},wait:0}];
const input=members=>({members,data,phases,duration:35,initialCost:10,mode:'timeline',repeat:false,caseKeys:['mean'],settings:Object.fromEntries(members.map(m=>[m.student.Id,{first:999,publicInterval:0}]))});
const casts=r=>r.paths[0].events.filter(e=>e.type==='cast'&&e.actionId!==undefined);

test('Five selected initial skills expose three cards and cycle used cards through the queue',()=>{
  const d=skillDeck([1,2,3,4,5,6],[6,4,2,5,1]);
  assert.deepEqual(d.hand,[6,4,2]);assert.deepEqual(d.queue,[5,1,3]);
  assert.equal(rotateSkill(d,3),false);assert.equal(rotateSkill(d,6),true);
  assert.deepEqual(d.hand,[5,4,2]);assert.deepEqual(d.queue,[1,3,6]);
  rotateSkill(d,5);rotateSkill(d,1);rotateSkill(d,3);assert.deepEqual(d.hand,[6,4,2]);
  removeSkill(d,4);assert.deepEqual(d.hand,[6,5,2]);assert.ok(!d.queue.includes(4));
});

test('A card unavailable in the hand cannot spend cost or deal EX damage',()=>{
  const members=[10000,13010,10007,13000,26003,20008].map(member);
  const r=simulateTactic({...input(members),sequence:[{studentId:13000,key:'Ex',earliest:0}]});
  assert.equal(casts(r).length,0);assert.equal(r.paths[0].events.find(e=>e.type==='blocked').nextAvailable,Infinity);
  assert.equal(pointAt(r.paths[0],0).cost,10);
  const good=simulateTactic({...input(members),startingOrder:[13000,10000,10007,20008,26003],sequence:[{studentId:13000,key:'Ex',earliest:0}]});
  assert.equal(casts(good)[0].spent,2);assert.deepEqual(casts(good)[0].hand,[20008,10000,10007]);
});

test('Ui halves odd EX costs with rounding up for two uses, then restores the original',()=>{
  const ui=member(10035);ui.build.skills.Ex=5;
  const members=[ui,member(10000),member(13000)];
  const r=simulateTactic({...input(members),sequence:[{studentId:10035,key:'Ex',targetId:10000,earliest:0},...[4,14,24].map(earliest=>({studentId:10000,key:'Ex',earliest}))]});
  assert.deepEqual(casts(r).map(e=>e.spent),[3,2,2,4]);
  assert.equal(exCost({Cost:[5]},1,{type:'Coefficient',value:-5000,uses:1}),3);
});

test('New Year Fuuka overwrites Ui cost reduction with one use instead of stacking it',()=>{
  const ui=member(10035);ui.build.skills.Ex=5;
  const fuuka=member(20022);fuuka.build.skills.Ex=5;
  const members=[ui,fuuka,member(10000)];
  const r=simulateTactic({...input(members),sequence:[{studentId:10035,key:'Ex',targetId:10000,earliest:0},{studentId:20022,key:'Ex',targetId:10000,earliest:3},...[7,20].map(earliest=>({studentId:10000,key:'Ex',earliest}))]});
  assert.deepEqual(casts(r).map(e=>e.spent),[3,2,2,4]);
  const early=simulateTactic({...input(members),sequence:[{studentId:10035,key:'Ex',targetId:10000,earliest:0},{studentId:10000,key:'Ex',earliest:1}]});
  assert.equal(casts(early)[1].spent,4);
});

test('Swimsuit Shiroko opening skill reduces every other member once and also buffs critical chance',()=>{
  const members=[member(20027),member(10000),member(13000)];
  const r=simulateTactic({...input(members),sequence:[{studentId:10000,key:'Ex',earliest:4},{studentId:13000,key:'Ex',earliest:10},{studentId:10000,key:'Ex',earliest:20}]});
  assert.deepEqual(casts(r).map(e=>e.spent),[3,1,4]);
  assert.equal(r.paths[0].events.filter(e=>e.type==='cost-buff').length,1);
  assert.ok(r.paths[0].records.some(e=>e.skillId==='20027:Public'));
});

test('Support unique weapons at four stars increase the cost cap by 0.5 each',()=>{
  const members=[member(10000),member(20008),member(26003)];
  for(const m of members.slice(1)){m.build.stars=5;m.build.weaponStars=4;}
  const r=simulateTactic({...input(members),initialCost:11,sequence:[]});
  assert.equal(r.costCap,11);assert.equal(pointAt(r.paths[0],35).cost,11);
});

test('Starting skill changes invalidate cached placement decisions',()=>{
  const members=[10000,13010,10007,13000,26003,20008].map(member),base=input(members);
  const a={...base,sequence:[],prepared:prepareTeam(members,data),startingOrder:[10000,13010,10007,13000,26003]};
  const b={...a,startingOrder:[13000,13010,10007,10000,26003]};
  assert.notEqual(tacticInputStamp(a),tacticInputStamp(b));
});
