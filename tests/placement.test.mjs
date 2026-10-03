import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultBuild } from '../calc.mjs';
import { prepareTeam } from '../team.mjs';
import { TacticUI } from '../tactic-ui.mjs';

const data=JSON.parse(await readFile(new URL('../data/global.json',import.meta.url),'utf8'));
const members=[10000,13010,10007,13000,26003,20008].map(id=>{const student=data.students.find(s=>s.Id===id);return {student,build:defaultBuild(student,data.meta.region)};});
const phases=[{name:'target',hp:1e9,enemy:{level:1,defense:0,armor:'LightArmor',terrain:'Street',critResist:100,critDmgResist:50,evasion:0},wait:0}];

test('A validated card is rechecked when starting cost changes, and snaps to the new recovery time',()=>{
  const ui=Object.create(TacticUI.prototype);
  ui.sequence=[{studentId:10000,key:'Ex',earliest:0,delay:0}];
  let initialCost=10;
  ui.input=()=>({members,data,prepared:prepareTeam(members,data),phases,sequence:ui.sequence,duration:60,initialCost,mode:'timeline',repeat:false,enemyPlan:[]});
  assert.equal(ui.fitAction(0),true);assert.equal(ui.sequence[0].earliest,0);
  const stamp=ui.validationStamp;
  assert.equal(ui.fitAction(0),true);assert.equal(ui.validationStamp,stamp);
  initialCost=0;
  assert.equal(ui.fitAction(0),true);assert.ok(ui.sequence[0].earliest>=9.5);assert.notEqual(ui.validationStamp,stamp);
});

test('A card outside a shortened battle cannot reuse its old placement approval',()=>{
  const ui=Object.create(TacticUI.prototype);ui.sequence=[{studentId:10000,key:'Ex',earliest:10,delay:0}];
  let duration=60;
  ui.input=()=>({members,data,prepared:prepareTeam(members,data),phases,sequence:ui.sequence,duration,initialCost:10,mode:'timeline',repeat:false,enemyPlan:[]});
  assert.equal(ui.fitAction(0),true);duration=5;assert.equal(ui.fitAction(0),false);
});
