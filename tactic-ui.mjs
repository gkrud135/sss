import { skillOptions, SKILL_NAMES } from './calc.mjs';
import { teamContext } from './team.mjs';
import { CASES, normalTiming, phaseProfile, pointAt, publicInterval, simulateTactic } from './tactic.mjs';
import { EnemyUI } from './enemy-ui.mjs';
import { atLevel } from './calc.mjs';
import { exCost, firstImpact, focusProfile, removeSkill, rotateSkill, skillDeck } from './rules.mjs';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Math.round(n).toLocaleString('ko-KR');
const seconds = n => n === null || n === undefined ? '시간 내 미완료' : `${Math.floor(n / 60)}:${(n % 60).toFixed(1).padStart(4, '0')}`;
// Chart colours are display-only; the simulation never reads them.
const CASE_COLOR = { mean: '#0a95cc', lucky: '#9a63e0', ceiling: '#c98a14' };
const UNIT_COLORS = ['#0a95cc', '#9a63e0', '#c98a14', '#1fa57b'];
const INK = { grid: '#d5e3ed', axis: '#52697d', cursor: '#0b1a2c' };
const ARROW = '<i class="to" aria-hidden="true"></i><span class="sr-only"> 에서 </span>';
const label = text => esc(text).replaceAll(' → ', ` ${ARROW} `);
const clamp01 = n => Math.max(0, Math.min(1, n));
const opts = (rows, selected) => rows.map(([value, label]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`).join('');

export function tacticInputStamp(input) {
  return JSON.stringify([input.members.map(m=>[m.student.Id,m.build]),input.phases,input.corrections,input.sequence,input.settings,input.duration,input.initialCost,input.mode,input.repeat,input.cycle,input.enemyPlan,input.incomingMode,input.startingOrder]);
}

export function actionDamage(path,id){
  let damage=0,first=null,last=null,count=0;
  for(const e of path.events)if(e.type==='damage'&&e.actionId===id){damage+=e.damage;first??=e.time;last=e.time;count++;}
  return count?{damage,first,last,count}:null;
}

export class TacticUI {
  constructor(getState) {
    this.getState = getState; this.sequence = []; this.phases = []; this.settings = {}; this.result = null;
    this.signature = ''; this.frame = null; this.dirty = true; this.selectedAction = 0;
    this.updateTimer=null;this.validationStamp=null;this.resultStamp=null;this.insertionTime=0;
    this.startingOrder=[];
    this.enemies=new EnemyUI(getState,()=>this.markDirty());
    $('ex-palette').addEventListener('click',event=>{const card=event.target.closest('[data-ex-student]');if(card)this.addEX(Number(card.dataset.exStudent));});
    $('starting-skills').addEventListener('change',event=>{
      const slot=Number(event.target.dataset.startSlot),id=Number(event.target.value),old=this.startingOrder[slot],other=this.startingOrder.indexOf(id);
      if(other>=0)this.startingOrder[other]=old;this.startingOrder[slot]=id;
      this.renderStarting();this.markDirty();
    });
    $('action-rows').addEventListener('change', event => this.changeAction(event));
    $('action-rows').addEventListener('input', event => { if (event.target.type === 'number') this.changeAction(event); });
    $('planned-timeline').addEventListener('pointerdown', event => {
      const enemyButton=event.target.closest('[data-planned-enemy]');
      if(enemyButton){if(this.enemies.random)return;const index=Number(enemyButton.dataset.plannedEnemy);this.enemies.select(index);this.drag={enemy:true,index,button:enemyButton,rect:enemyButton.parentElement.getBoundingClientRect(),old:this.enemies.plan[index].time};$('planned-timeline').setPointerCapture(event.pointerId);this.stop();return;}
      const button = event.target.closest('[data-planned-action]'); if (!button) return;
      this.selectedAction = Number(button.dataset.plannedAction); this.renderActions();
      $('time-cursor').value=this.sequence[this.selectedAction].earliest;this.insertionTime=Number($('time-cursor').value)+.5;if(this.result)this.renderTime();
      this.drag = { index: Number(button.dataset.plannedAction), button, rect: button.parentElement.getBoundingClientRect(), old: this.sequence[Number(button.dataset.plannedAction)].earliest };
      $('planned-timeline').setPointerCapture(event.pointerId); this.stop();
    });
    $('planned-timeline').addEventListener('click', event => {
      if (event.target.closest('[data-planned-action],[data-planned-enemy]')) return;
      const track = event.target.closest('.plan-track') ?? event.target.closest('.plan-axis')?.lastElementChild;
      if (!track) return;
      const rect = track.getBoundingClientRect(), duration = Number($('sim-duration').value) || 180;
      const time = Math.max(0, Math.min(duration, (event.clientX - rect.left) / rect.width * duration));
      this.stop(); $('time-cursor').value = time; $('plan-clock').textContent = seconds(time);
      this.insertionTime=time;
      if (this.result) this.renderTime(); else $('plan-playhead').style.left = `${124 + time / duration * Math.max(500, duration * (Number($('timeline-zoom').value) || 8))}px`;
    });
    $('planned-timeline').addEventListener('pointermove', event => {
      if (!this.drag) return;
      this.drag.moved = true;
      const duration = Number($('sim-duration').value) || 180, { index, button, rect } = this.drag;
      const time = Math.round(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration * 10) / 10;
      if(this.drag.enemy){this.enemies.plan[index].time=time;$('enemy-action-editor').querySelector('[data-field="time"]').value=time;}
      else{this.sequence[index].earliest = time; $('action-rows').querySelector(`[data-index="${index}"][data-field="earliest"]`).value = time;}
      button.style.left = `${time / duration * 100}%`; button.textContent = `${index + 1} · ${time.toFixed(1)}초`;
    });
    const finishDrag = () => { if (!this.drag) return; const { index, old, moved,enemy } = this.drag; this.drag = null; if (!moved) return; if(enemy)this.enemies.render();else{if (!this.fitAction(index)) this.sequence[index].earliest = old;this.renderActions();} this.markDirty(); };
    $('planned-timeline').addEventListener('pointerup', finishDrag);
    $('planned-timeline').addEventListener('pointercancel', finishDrag);
    $('planned-timeline').addEventListener('keydown', event => {
      const enemy=event.target.closest('[data-planned-enemy]');
      if(enemy && ['ArrowLeft','ArrowRight'].includes(event.key)){if(this.enemies.random)return;event.preventDefault();const index=Number(enemy.dataset.plannedEnemy),a=this.enemies.plan[index];a.time=Math.max(0,Math.round((a.time+(event.key==='ArrowRight' ? .1 : -.1))*10)/10);this.enemies.render();this.markDirty();$('planned-timeline').querySelector(`[data-planned-enemy="${index}"]`)?.focus({preventScroll:true});return;}
      const button = event.target.closest('[data-planned-action]');
      if (!button || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); const a = this.sequence[Number(button.dataset.plannedAction)];
      a.earliest = Math.max(0, Math.min(Number($('sim-duration').value) || 180, Math.round((a.earliest + (event.key === 'ArrowRight' ? .1 : -.1)) * 10) / 10));
      this.fitAction(Number(button.dataset.plannedAction)); this.renderActions(); this.markDirty();
      $('planned-timeline').querySelector(`[data-planned-action="${button.dataset.plannedAction}"]`)?.focus({ preventScroll: true });
    });
    $('action-rows').addEventListener('click', event => {
      const button = event.target.closest('[data-action-op]'); if (!button) return;
      const index = Number(button.dataset.index), op = button.dataset.actionOp;
      if (op === 'remove') this.sequence.splice(index, 1);
      else { const next = index + (op === 'up' ? -1 : 1); if (next >= 0 && next < this.sequence.length) [this.sequence[index], this.sequence[next]] = [this.sequence[next], this.sequence[index]]; }
      this.renderActions(); this.markDirty();
    });
    $('phase-rows').addEventListener('input', event => {
      const { index, field } = event.target.dataset; if (index === undefined) return;
      const phase = this.phases[Number(index)];
      if (field === 'clearDebuffs') phase.clearDebuffs = event.target.checked;
      else if (field === 'defense') phase.enemy = { ...phase.enemy, defense: Math.max(0, Number(event.target.value)) };
      else phase[field] = Math.max(field === 'hp' ? 1 : 0, Number(event.target.value));
      this.markDirty();
    });
    $('phase-add').addEventListener('click', () => { const enemy = this.getState().enemy; this.phases.push({ name: `${this.phases.length + 1}페이즈 · 직접 설정`, hp: 1000000, enemy, wait: 0, received: 100, carry: false, clearDebuffs: true }); this.renderPhases(); this.markDirty(); });
    $('phase-rows').addEventListener('click', event => { const button = event.target.closest('[data-phase-remove]'); if (button && this.phases.length > 1) { this.phases.splice(Number(button.dataset.phaseRemove), 1); this.renderPhases(); this.markDirty(); } });
    $('phase-reload').addEventListener('click', () => { this.loadPhases(); this.markDirty(); });
    $('auto-settings').addEventListener('input', event => {
      const { student, field } = event.target.dataset; if (!student) return;
      this.settings[student] ??= {}; this.settings[student][field] = Math.max(field === 'interval' ? .1 : 0, Number(event.target.value)); this.markDirty();
    });
    for (const id of ['sim-duration', 'initial-cost', 'sequence-repeat', 'tactic-mode', 'cycle-seconds']) $(id).addEventListener('change', () => this.markDirty());
    $('tactic-graph').addEventListener('click', event => { const marker = event.target.closest('[data-event-time]'); if (marker) { this.stop(); $('time-cursor').value = marker.dataset.eventTime; this.renderTime(); } });
    // One transport button: calculate if the board changed, then play or pause.
    $('plan-play').addEventListener('click', () => { if (!this.result || this.dirty) this.run(); this.frame === null ? this.play() : this.stop(); });
    const resultTabs = $('tactic-results').querySelector('.result-tabs');
    resultTabs.addEventListener('click', event => { const tab = event.target.closest('[data-result-tab]'); if (tab) this.showResultTab(tab.dataset.resultTab); });
    resultTabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...resultTabs.querySelectorAll('[data-result-tab]')], index = tabs.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault(); this.showResultTab(tabs[next].dataset.resultTab); tabs[next].focus();
    });
    $('timeline-zoom').addEventListener('input', () => this.renderPlan());
    $('action-rows').addEventListener('focusout', event => {
      if(event.target.type!=='number')return;
      const index = Number(event.target.dataset.index); if (!Number.isFinite(index) || !this.sequence[index]) return;
      if (!this.fitAction(index) && this.acceptedSequence?.[index]) this.sequence[index] = structuredClone(this.acceptedSequence[index]);
      this.renderActions(); this.markDirty();
    });
    $('time-cursor').addEventListener('input', () => { this.stop();this.insertionTime=Number($('time-cursor').value); this.renderTime(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stop(); });
  }
  markDirty() {
    this.enemies.refresh(this.phases);
    this.dirty = true; this.stop(); $('tactic-status').textContent = '미리보기 갱신 중…';
    $('tactic-results').classList.toggle('stale', Boolean(this.result));
    this.renderPlan();
    clearTimeout(this.updateTimer);this.updateTimer=setTimeout(()=>{this.updateTimer=null;if(!this.drag)this.run();},180);
  }
  addEX(studentId) {
    const state=this.getState(),member=state.members.find(m=>m.student.Id===studentId);if(!member)return;
    const prior=structuredClone(this.sequence);
    const entry=this.paletteEntry(member,this.insertionTime);if(!entry)return;
    const target=state.members.filter(m=>m.student.SquadType==='Main').sort((a,b)=>state.prepared.get(b.student.Id).calculated.stats.AttackPower-state.prepared.get(a.student.Id).calculated.stats.AttackPower)[0];
    const effectIndex=Math.max(0,entry.skill.Effects?.findIndex(e=>e.Type==='Damage')??0);
    this.sequence.push({studentId,key:'Ex',targetId:target?.student.Id,earliest:this.insertionTime,
      delay:firstImpact(entry.skill,entry.skill.Effects?.[effectIndex]),sourceTiming:true,effectIndex,assumeCondition:false,buffDuration:0});
    const index=this.sequence.length-1;
    if(!this.fitAction(index)){this.sequence=prior;this.validationStamp=null;this.renderPlan();return;}
    this.selectedAction=index;this.insertionTime=this.sequence[index].earliest+.5;$('time-cursor').value=this.sequence[index].earliest;
    this.renderActions();this.markDirty();
  }
  paletteEntry(member,time){
    const entries=skillOptions(member.student,this.getState().prepared.get(member.student.Id).build);
    const state=this.result?.paths[0].events.filter(e=>e.studentId===member.student.Id&&e.nextSkillKey&&e.time<=time).at(-1);
    const key=focusProfile(member.student)&&state?.stanceUntil>time?state.nextSkillKey:'Ex';
    return entries.find(e=>e.key===key)??entries.find(e=>e.key==='Ex');
  }
  renderPalette() {
    const {members,prepared}=this.getState();
    const deck=skillDeck(members.map(m=>m.student.Id),this.startingOrder);
    for(const a of [...this.sequence].sort((a,b)=>a.earliest-b.earliest))if(a.key==='Ex'&&a.earliest<this.insertionTime)rotateSkill(deck,a.studentId);
    const result=this.result?.paths[0],at=this.insertionTime;
    if(result&&!this.dirty){const latest=result.events.filter(e=>e.hand&&e.time<=at).at(-1);if(latest)deck.hand=[...latest.hand];}
    const deaths=new Set(result?.events.filter(e=>e.type==='death'&&e.time<=at).map(e=>e.studentId)??[]);
    for(const id of deaths)removeSkill(deck,id);
    const modifiers=new Map();
    for(const event of result?.events??[]){
      if(event.time>=at)continue;
      if(event.type==='cost-buff')for(const id of event.targets)modifiers.set(id,{...event.modifier});
      if(event.type==='cast'&&event.actionId!==undefined&&modifiers.has(event.studentId))modifiers.get(event.studentId).uses--;
    }
    $('ex-palette').innerHTML=members.map(m=>{
      const entry=this.paletteEntry(m,at);
      const cost=exCost(entry?.skill??{},prepared.get(m.student.Id).build.skills.Ex??1,modifiers.get(m.student.Id));
      const disabled=!deck.hand.includes(m.student.Id)||deaths.has(m.student.Id);
      return `<button type="button" class="ex-card" ${disabled?'disabled':''} data-ex-student="${m.student.Id}" aria-label="${esc(m.student.Name)} EX 추가, 코스트 ${cost}"><img src="https://schaledb.com/images/student/collection/${m.student.Id}.webp" alt=""><span><strong>${esc(m.student.Name)}</strong><small>${esc(entry?.skill.Name??'EX')}</small></span><b class="ex-cost">${cost}</b></button>`;
    }).join('')||'<p class="helper">먼저 위에서 파티를 편성하세요.</p>';
  }
  renderStarting(){
    const {members}=this.getState(),ids=members.map(m=>m.student.Id);
    this.startingOrder=skillDeck(ids,this.startingOrder).hand.concat(skillDeck(ids,this.startingOrder).queue).slice(0,5);
    $('starting-skills').innerHTML=this.startingOrder.map((id,i)=>`<label>${i+1}${i<3?' · 시작 손패':' · 다음 카드'}<select data-start-slot="${i}" aria-label="시작 순서 ${i+1}">${opts(members.map(m=>[m.student.Id,m.student.Name]),id)}</select></label>`).join('');
  }
  renderPlan() {
    const {members,raidData}=this.getState(),duration=Number($('sim-duration').value)||180;
    const zoom=Number($('timeline-zoom').value)||8,width=Math.max(500,duration*zoom);
    $('planned-timeline').style.setProperty('--track-width',`${width}px`);$('planned-timeline').style.setProperty('--zoom',`${zoom}px`);
    const mean=this.result?.paths[0];
    const clips=this.sequence.map((a,i)=>{
      const m=members.find(m=>m.student.Id===a.studentId);if(!m)return '';
      return `<button type="button" class="party-clip ${i===this.selectedAction?'selected':''}" data-planned-action="${i}" style="left:${Math.min(100,a.earliest/duration*100)}%;width:${Math.max(92,(a.delay+.5)*zoom)}px" aria-label="${esc(m.student.Name)} EX, ${a.earliest.toFixed(1)}초. 끌어서 시각 변경"><img src="https://schaledb.com/images/student/collection/${m.student.Id}.webp" alt=""><span><b>${esc(m.student.Name)}</b><small>${a.earliest.toFixed(1)}초</small></span></button>`;
    }).join('');
    const actorId=this.phases[Math.min(pointAt(mean??{timeline:[]},Number($('time-cursor').value)).phase??0,this.phases.length-1)]?.enemy.character?.Id;
    const visible=this.enemies.plan.map((a,i)=>({a,i})).filter(({a,i})=>!this.enemies.random || (mean&&!this.dirty?mean.events.some(e=>e.type==='enemy-cast'&&e.enemyActionIndex===i):a.enemyId===(this.phases[0]?.enemy.character?.Id??actorId)));
    const enemyClips=visible.map(({a,i})=>`<button type="button" data-planned-enemy="${i}" ${this.enemies.random?'class="random-pattern" tabindex="-1"':''} style="left:${Math.min(100,a.time/duration*100)}%;width:${Math.max(64,(a.delay+.5)*zoom)}px" aria-label="보스 패턴 ${i+1}, ${a.time.toFixed(1)}초"><b>${esc(raidData.enemySkills[a.skillId]?.Name??'기믹')}</b><small>${a.time.toFixed(1)}초</small></button>`).join('');
    $('planned-timeline').innerHTML=`<div class="plan-axis"><span>1 PARTY</span><div>${Array.from({length:Math.floor(duration/10)+1},(_,i)=>`<small style="left:${i*10/duration*100}%">${i*10}초</small>`).join('')}</div></div><div id="plan-playhead" class="plan-playhead" style="left:${124+Number($('time-cursor').value)/duration*width}px"></div><div class="plan-row party-row"><strong>파티 EX</strong><div class="plan-track">${clips}</div></div><div class="plan-row enemy-track"><strong>보스 / 기믹</strong><div class="plan-track">${enemyClips}</div></div>`;
  }
  input() {
    const state=this.getState();this.enemies.refresh(this.phases);
    const corrections=Object.fromEntries(['attackBuff','critBuff','defDown','penetration','effectiveBuff','exBuff','damageBuff'].map(key=>[key,state.enemy[key]]));
    const phases=this.phases.map(p=>({...p,enemy:!state.raid?{...state.enemy,defense:p.enemy.defense}:p.enemy.character?.Id===state.enemy.character?.Id?{...p.enemy,level:state.enemy.level,critResist:state.enemy.critResist,critDmgResist:state.enemy.critDmgResist,evasion:state.enemy.evasion}:p.enemy}));
    return {...state,phases,corrections,sequence:this.sequence,settings:this.settings,duration:Number($('sim-duration').value),initialCost:Number($('initial-cost').value),mode:$('tactic-mode').value,repeat:$('sequence-repeat').checked,cycle:Number($('cycle-seconds').value),enemyPlan:this.enemies.plan,incomingMode:$('incoming-mode').value,startingOrder:this.startingOrder};
  }
  inputStamp(input) {
    return tacticInputStamp(input);
  }
  fitAction(index) {
    const input=this.input(),stamp=this.inputStamp(input);
    if(!Number.isFinite(this.sequence[index].earliest)||this.sequence[index].earliest>input.duration)return false;
    if(this.validationStamp===stamp)return true;
    if(input.mode!=='timeline'){this.validationStamp=stamp;this.acceptedSequence=structuredClone(this.sequence);return true;}
    const original=this.sequence[index].earliest;
    for(let attempt=0;attempt<30;attempt++){
      const r=simulateTactic({...input,sequence:this.sequence,repeat:false,caseKeys:['mean'],recordTimeline:false});
      const path=r.paths[0],blocked=path.events.find(e=>e.type==='blocked');
      const end=path.wipeTime??path.clearTime;
      if(end!==null && this.sequence[index].earliest>end){this.sequence[index].earliest=original;return false;}
      if(!blocked){this.validationStamp=this.inputStamp(this.input());this.acceptedSequence=structuredClone(this.sequence);return true;}
      const blocker=Number(blocked.actionId.split('-')[0]);
      this.sequence[index].earliest=Math.round(Math.max(this.sequence[index].earliest+.1,blocker===index?blocked.nextAvailable:this.sequence[blocker].earliest+.1)*10)/10;
      if(!Number.isFinite(this.sequence[index].earliest)||this.sequence[index].earliest>input.duration)break;
    }
    this.sequence[index].earliest=original;return false;
  }
  sync() {
    const { members } = this.getState();
    const signature = this.contextSignature();
    if (signature !== this.signature) { this.signature = signature; this.loadPhases(); }
    this.enemies.sync();this.enemies.refresh(this.phases);this.renderStarting();this.renderPalette(); this.renderActions(); this.renderAuto(members); this.markDirty();
  }
  contextSignature() {
    const { battleKey, raid, difficulty, enemy } = this.getState();
    return `${battleKey??''}:${raid?.Id ?? 'custom'}:${difficulty}:${enemy.character?.Id}:${enemy.terrain}:${enemy.armor}`;
  }
  captureDraft() {
    this.stop();clearTimeout(this.updateTimer);this.updateTimer=null;
    return { sequence:this.sequence, phases:this.phases, settings:this.settings,
      startingOrder:this.startingOrder, selectedAction:this.selectedAction, insertionTime:this.insertionTime };
  }
  restoreDraft(draft) {
    this.stop();clearTimeout(this.updateTimer);this.updateTimer=null;
    this.sequence=draft?.sequence??[];this.phases=draft?.phases??[];this.settings=draft?.settings??{};
    this.startingOrder=draft?.startingOrder??[];this.selectedAction=draft?.selectedAction??0;this.insertionTime=draft?.insertionTime??0;
    this.signature=draft?this.contextSignature():'';
    this.result=null;this.validationStamp=null;this.resultStamp=null;this.acceptedSequence=null;
    $('tactic-results').hidden=true;
    this.renderPhases();this.renderPhaseSource();
  }
  loadPhases() {
    const { raidData, raid, difficulty, enemy } = this.getState();
    this.phases = phaseProfile(raidData, raid, difficulty, enemy, enemy.terrain, enemy.armor);
    $('sim-duration').value = raid?.BattleDuration?.[difficulty] ?? 180;
    this.renderPhaseSource();this.renderPhases();
  }
  renderPhaseSource() {
    const {raid}=this.getState();
    $('phase-source').textContent = raid?.ContentType==='drill' ? '선택한 시험 적 1체의 HP를 사용합니다. 시험의 전체 웨이브나 클리어 시간·점수로 해석하지 마세요. 특수 규칙의 효과는 직접 보정해야 합니다.' : raid ? '원본의 HP 전환점 / 연속 보스 기준입니다. 성배·게이지·분신·소환몹·피해 전이는 자동 처리하지 않습니다. 전환 대기는 기본 0초이므로 실제 택틱에 맞춰 수정하세요.' : '직접 입력한 적 능력치와 페이즈 HP를 사용합니다.';
  }
  renderPhases() {
    $('phase-rows').innerHTML = this.phases.map((p, index) => `<div class="phase-row"><strong>${esc(p.name)}</strong><label>이 페이즈에 필요한 피해<input type="number" min="1" step="1000" data-index="${index}" data-field="hp" value="${p.hp}"></label><label>방어력<input type="number" min="0" data-index="${index}" data-field="defense" value="${p.enemy.defense ?? 0}"></label><label>피해 배율 (%)<input type="number" min="0" step="10" data-index="${index}" data-field="received" value="${p.received ?? 100}"></label><label>완료 후 대기 (초)<input type="number" min="0" step=".1" data-index="${index}" data-field="wait" value="${p.wait ?? 0}"></label><label class="check"><input type="checkbox" data-index="${index}" data-field="clearDebuffs" ${p.clearDebuffs ? 'checked' : ''}>적 디버프 해제</label><button type="button" class="tiny-button" data-phase-remove="${index}" ${this.phases.length === 1 ? 'disabled' : ''}>삭제</button></div>`).join('');
  }
  renderActions() {
    const {members,prepared}=this.getState();
    this.selectedAction=Math.min(this.selectedAction,Math.max(0,this.sequence.length-1));
    const index=this.selectedAction,a=this.sequence[index],m=members.find(m=>m.student.Id===a?.studentId);
    if(!a||!m){$('action-rows').innerHTML='';return;}
    const entries=skillOptions(m.student,prepared.get(m.student.Id).build).filter(e=>!['Normal','Passive'].includes(e.type));
    const actual=this.result?.paths[0].events.find(e=>e.type==='cast'&&e.actionId===`${index}-0`)?.skillKey;
    const selected=entries.find(e=>e.key===(focusProfile(m.student)&&a.key==='Ex'?actual??a.key:a.key));
    const damage=(selected?.skill.Effects??[]).flatMap((e,i)=>e.Type==='Damage'?[[i,`${i+1}번 직접 피해`]]:[]);
    const cost=selected?.type==='Ex'?atLevel(selected.skill.Cost,prepared.get(m.student.Id).build.skills.Ex??1):0;
    $('action-rows').innerHTML=`<div class="ex-inspector"><div class="ex-inspector-main"><img src="https://schaledb.com/images/student/collection/${m.student.Id}.webp" alt=""><span><strong>${esc(m.student.Name)} · ${esc(selected?.skill.Name)}</strong><small>${index+1}번째 카드 · 코스트 ${cost}</small></span><label>사용 시각 (초)<input type="number" min="0" step=".1" data-index="${index}" data-field="earliest" value="${a.earliest}"></label><label>스킬 대상<select data-index="${index}" data-field="targetId">${opts(members.filter(m=>m.student.SquadType==='Main').map(m=>[m.student.Id,m.student.Name]),a.targetId)}</select></label><button type="button" class="tiny-button" data-index="${index}" data-action-op="remove">카드 삭제</button></div><details class="ex-advanced" ${$('action-rows').querySelector('.ex-advanced')?.open?'open':''}><summary>스킬 세부 설정</summary><div class="field-grid"><label>학생<select data-index="${index}" data-field="studentId">${opts(members.map(m=>[m.student.Id,m.student.Name]),a.studentId)}</select></label><label>사용할 스킬<select data-index="${index}" data-field="key">${opts(entries.map(e=>[e.key,`${SKILL_NAMES[e.type]} · ${e.skill.Name??'추가 효과'}`]),a.key)}</select></label><label class="check"><input type="checkbox" data-index="${index}" data-field="sourceTiming" ${a.sourceTiming?'checked':''}>원본 타격 시점 사용</label><label>첫 피해 지연 보정 (초)<input type="number" min="0" step=".1" data-index="${index}" data-field="delay" ${a.sourceTiming?'disabled':''} value="${a.delay.toFixed(2)}"></label><label>버프 지속 보정 (초, 0=원본)<input type="number" min="0" step=".1" data-index="${index}" data-field="buffDuration" value="${a.buffDuration??0}"></label><label>피해 효과<select data-index="${index}" data-field="effectIndex">${opts(damage.length?damage:[[0,'직접 피해 없음']],a.effectIndex)}</select></label><label class="check"><input type="checkbox" data-index="${index}" data-field="assumeCondition" ${a.assumeCondition?'checked':''}>조건 충족 가정</label></div></details></div>`;
  }
  changeAction(event) {
    const { index, field } = event.target.dataset; if (index === undefined) return;
    const a = this.sequence[Number(index)];
    a[field] = field === 'key' ? event.target.value : ['assumeCondition','sourceTiming'].includes(field) ? event.target.checked : Math.max(0, Number(event.target.value));
    if (field === 'studentId' || field === 'key') {
      const m = this.getState().members.find(m => m.student.Id === a.studentId);
      if (field === 'studentId') a.key = 'Ex';
      const entry = skillOptions(m.student, this.getState().prepared.get(m.student.Id).build).find(e => e.key === a.key);
      a.delay = firstImpact(entry?.skill,entry?.skill.Effects?.find(e=>e.Type==='Damage'));
      a.sourceTiming=true;
      a.effectIndex = entry?.skill.Effects?.findIndex(e => e.Type === 'Damage') ?? 0;
      a.buffDuration = entry?.type === 'ExtraPassive' ? 30 : 0;
    }
    if (event.target.tagName === 'SELECT') {
      if (!this.fitAction(Number(index)) && this.acceptedSequence?.[Number(index)]) this.sequence[Number(index)] = structuredClone(this.acceptedSequence[Number(index)]);
      this.renderActions();
    }
    if(field==='sourceTiming')this.renderActions();
    this.markDirty();
  }
  renderAuto(members) {
    $('auto-settings').innerHTML = members.map(m => {
      const timing = { ...normalTiming(m.student), publicInterval: publicInterval(m.student.Skills.Public), ...this.settings[m.student.Id] };
      return `<div class="auto-row"><strong>${esc(m.student.Name)}</strong>${m.student.SquadType === 'Main' ? `<label>일반 공격 주기 (초)<input data-student="${m.student.Id}" data-field="interval" type="number" min=".1" step=".1" value="${timing.interval.toFixed(2)}"></label>` : '<span class="helper">일반 공격 없음</span>'}<label>기본 스킬 주기 (초, 0=끄기)<input data-student="${m.student.Id}" data-field="publicInterval" type="number" min="0" step=".1" value="${timing.publicInterval}"></label><small>탄창 ${timing.rounds}회 · 재장전 ${timing.reload.toFixed(2)}초</small></div>`;
    }).join('');
  }
  run() {
    clearTimeout(this.updateTimer);this.updateTimer=null;this.stop();
    try {
      let input=this.input(),stamp=this.inputStamp(input);
      if(this.resultStamp===stamp&&this.result){this.dirty=false;$('tactic-results').classList.remove('stale');$('tactic-status').textContent=this.lastStatus;this.renderTime();return;}
      if(this.validationStamp!==stamp && input.mode==='timeline'){
        for(let i=this.sequence.length-1;i>=0;i--)if(!this.fitAction(i))this.sequence.splice(i,1);
        input=this.input();stamp=this.inputStamp(input);
      }
      if(input.repeat&&input.mode==='timeline'&&this.repeatStamp!==stamp){
        const check=simulateTactic({...input,caseKeys:['mean'],recordTimeline:false});
        if(check.paths[0].events.some(e=>e.type==='blocked')){$('sequence-repeat').checked=false;input=this.input();stamp=this.inputStamp(input);}
        this.repeatStamp=stamp;
      }
      const selectedTime=Number($('time-cursor').value),started=performance.now();
      input={...input,members:input.members.map(m=>({...m,build:structuredClone(m.build)}))};
      this.result=simulateTactic(input);this.runState=input;this.resultStamp=stamp;
      $('initial-cost').max=this.result.costCap;
      this.dirty=false;$('tactic-results').hidden=false;$('tactic-results').classList.remove('stale');
      $('tactic-status').textContent=`자동 갱신 완료 · ${(performance.now()-started).toFixed(0)}ms · 제외된 효과 ${this.result.warnings.length}개 안내 확인`;
      this.lastStatus=$('tactic-status').textContent;
      $('time-cursor').max=this.result.duration;$('time-cursor').value=Math.min(this.result.duration,selectedTime);
      this.renderResults();this.renderPlan();this.renderTime();
      if(!$('action-rows').contains(document.activeElement))this.renderActions();
    }catch(error){$('tactic-status').textContent=error.message;}
  }
  renderQuick() {
    if(!this.result)return;
    const mean=this.result.paths[0],time=Number($('time-cursor').value),p=pointAt(mean,time),cap=this.result.costCap;
    const next=mean.events.find(e=>e.type==='enemy-cast'&&e.time>time+.01);
    const action=mean.events.find(e=>e.type==='cast'&&e.actionId===`${this.selectedAction}-0`);
    const gauge=`<div class="cost-gauge" role="img" aria-label="코스트 ${p.cost.toFixed(2)} / ${cap}">${Array.from({length:Math.ceil(cap)},(_,i)=>{const width=Math.min(1,cap-i);return `<i style="flex:${width};--fill:${clamp01((p.cost-i)/width).toFixed(3)}"></i>`;}).join('')}</div>`;
    $('quick-preview').innerHTML=`<div class="tile tile-cost"><small>현재 코스트</small><strong>${p.cost.toFixed(2)} <em>/ ${cap}</em></strong>${gauge}<span>회복 +${(p.regen??0).toFixed(3)} /초</span></div><div class="tile"><small>선택한 EX 코스트</small><strong>${action?`${action.beforeCost.toFixed(2)}${ARROW}${action.cost.toFixed(2)}`:'—'}</strong><span>${action?`${seconds(action.time)} 사용 · −${action.spent}`:'카드를 눌러 시작하세요'}</span></div><div class="tile tile-next"><small>다음 보스 기믹까지</small><strong>${next?`${(next.time-time).toFixed(1)}초`:'—'}</strong><span>${next?label(next.label):mean.wipeTime!==null&&time>=mean.wipeTime?'파티 전멸':'이후 예정된 기믹 없음'}</span></div>`;
  }
  renderResults() {
    const r = this.result;
    $('case-summary').innerHTML = r.paths.map((p, i) => `<div style="--case-color:${CASE_COLOR[CASES[i].key]}"><small>${esc(CASES[i].label)}</small><strong>${p.wipeTime!==null?`전멸 · ${seconds(p.wipeTime)}`:seconds(p.clearTime)}</strong><span>최종 ${num(p.damage)} / ${num(r.totalHP)} 피해</span><em class="at-cursor"></em></div>`).join('');
    $('phase-times').innerHTML = `<table><thead><tr><th>페이즈</th>${CASES.map(c => `<th>${esc(c.key === 'lucky' ? '상위 5% 추정' : c.label)}</th>`).join('')}</tr></thead><tbody>${r.phases.map((phase, index) => `<tr><th>${esc(phase.name)}<small>필요 피해 ${num(phase.hp)}</small></th>${r.paths.map(path => { const end = path.completions.find(c => c.phase === index)?.time; const start = index === 0 ? 0 : path.completions.find(c => c.phase === index - 1)?.time; return `<td>${seconds(end)}${end !== undefined ? `<small>소요 ${(end - start).toFixed(1)}초</small>` : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
    $('tactic-warnings').innerHTML = `<summary>계산 가정과 제외된 효과 (${r.warnings.length})</summary><p>0.1초 단위 단일 대상 HP 모델입니다. 일반 공격 주기는 프레임 자료로 추정하며, 기본 스킬 주기는 설명의 “초마다” 값을 사용합니다. 원본 타격 프레임이 있으면 각 타격 시점의 버프·페이즈를 계산합니다. 없는 효과는 적용 프레임 또는 스킬 길이로 첫 피해 시점을 추정하며 수동 보정할 수 있습니다. 범위 버프는 팀이 모두 범위 안에 있다고 가정합니다.</p><p>상위 5%는 독립 타격의 안정률 균등분포·치명타·명중에 대한 누적 피해 정규 근사입니다. 적은 타격 수와 페이즈 전환에서는 실제 클리어 시간의 95% 분위수를 보장하지 않습니다. 이론 고점은 모두 명중하고 가능한 치명타·최대 안정률이 나온 상한입니다.</p><p>배치한 실제 보스 스킬의 직접 피해·디버프·확정 행동 정지·지속 피해와 단순 회복·보호막을 계산합니다. 시작 순서 5개·손패 3개·EX 순환과 단순 코스트 감소는 반영합니다. 히나(드레스)의 준비·무료 사격 3회·10초 창 갱신·자세 해제를 반영합니다. 보스 AI의 시각·이동 경로·다른 변신/연속 EX·조건부 코스트 감소·소환·게이지와 복잡한 기믹은 자동 재현하지 않습니다. 랜덤 예시는 실제 스킬을 균등 선택하고, 설정 간격의 ±20%로 발동합니다. 같은 패턴을 유지하다가 다시 뽑기로 새 예시를 만듭니다. 실제 AI 확률·시간표는 아닙니다. 전체/인원 수가 설명에 있으면 반영하고 공간 판정은 랜덤 1인으로 대체합니다. 직접 배치 모드도 사용할 수 있습니다. 원형·선형 공격의 실제 위치 판정은 하지 않습니다. 사망한 스트라이커의 공격·코스트 회복을 중단하고 최대 HP 변화는 HP 비율을 유지합니다. 적 지형 보정은 중립, 지속 피해는 방어력·상성을 적용하는 모델입니다. 보호막은 같은 시전자 갱신·다른 시전자 합산 기준이며 실드 중첩·제어 저항·특수 회복은 실측 검증하지 않았습니다. 제외된 효과가 있으면 피해가 일부만 반영된 결과입니다. 보스 기본 피해 감소를 유지하며, 기믹 해제 상태는 페이즈의 추가 피해 배율로 직접 보정할 수 있습니다.</p>${r.warnings.length ? `<ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
    this.renderGraph();
    const costPath = r.paths[0].timeline;
    $('cost-graph').innerHTML = `<h3>코스트 회복 & 사용 <small>평균 경로 · 선은 남은 코스트</small></h3><svg viewBox="0 0 900 128" role="img" aria-label="시간에 따른 코스트 회복과 스킬 사용"><path d="M58,18H880M58,95H880" stroke="${INK.grid}"/><text x="48" y="22" text-anchor="end" font-size="13" fill="${INK.axis}">${r.costCap}</text><text x="48" y="99" text-anchor="end" font-size="13" fill="${INK.axis}">0</text><path d="${costPath.map((p,i) => `${i ? 'L' : 'M'}${(58 + p.time/r.duration*822).toFixed(2)},${(95 - p.cost/r.costCap*77).toFixed(2)}`).join(' ')}" stroke="${CASE_COLOR.mean}" stroke-width="2.5" fill="none"/>${[0,.25,.5,.75,1].map(f => `<text x="${58+f*822}" y="119" text-anchor="middle" fill="${INK.axis}" font-size="13">${Math.round(r.duration*f)}초</text>`).join('')}<path id="cost-cursor" d="M58,12V98" stroke="${INK.cursor}" opacity=".5"/></svg>`;
    const manual = r.paths[0].events.filter(e => e.actionId !== undefined && ['cast', 'blocked'].includes(e.type));
    $('action-results').innerHTML = `<table><thead><tr><th>사용 시각 · 행동</th><th>사용 전/후 코스트</th><th>피해 시각</th><th>평균 피해</th><th>상위 5% 추정</th><th>이론 고점</th></tr></thead><tbody>${manual.map(event => {
      const hits=r.paths.map(path=>actionDamage(path,event.actionId)),mean=hits[0];
      const nextGimmick=event.type==='cast'?r.paths[0].events.find(e=>e.type==='enemy-cast'&&e.time>event.time+.01):null;
      return `<tr><th>${seconds(event.time)} · ${label(event.label)}<small>${nextGimmick?`${label(nextGimmick.label.split(' · ').at(-1))}까지 ${(nextGimmick.time-event.time).toFixed(1)}초`:'이후 기믹 없음'}</small></th><td>${event.type==='blocked'?'실행 제외':`${event.beforeCost.toFixed(2)}${ARROW}${event.cost.toFixed(2)}`}</td><td>${mean?`${seconds(mean.first)}${mean.count>1?` – ${seconds(mean.last)} · ${mean.count}회`:''}`:'—'}</td>${r.paths.map((path,i)=>{const cast=path.events.find(e=>['cast','blocked'].includes(e.type)&&e.actionId===event.actionId);return `<td>${hits[i]?num(hits[i].damage):cast?.type==='blocked'?'실행 제외':'직접 피해 없음'}</td>`;}).join('')}</tr>`;
    }).join('')}</tbody></table>`;
    const mean = r.paths[0];
    const mains=this.runState.members.filter(m=>m.student.SquadType==='Main');
    $('survival-summary').innerHTML=`<table><thead><tr><th>학생</th>${CASES.map(c=>`<th>${esc(c.key==='lucky'?'상위 5% 추정':c.label)}</th>`).join('')}</tr></thead><tbody>${mains.map(m=>`<tr><th>${esc(m.student.Name)}</th>${r.paths.map(p=>{const unit=p.timeline.at(-1)?.health[m.student.Id];return `<td class="${unit?.deadAt!==null?'dead':'alive'}">${unit?.deadAt!==null?`${seconds(unit?.deadAt)} 사망`:`${p.events.some(e=>e.type==='enemy-cast')?'생존':'피격 패턴 미입력'} · HP ${num(unit?.hp??0)}`}</td>`;}).join('')}</tr>`).join('')}</tbody></table><p class="helper">배치한 적 공격을 ${$('incoming-mode').value==='mean'?'평균':'최대'} 피해로 받을 때의 결과입니다. 공격을 배치하지 않으면 공격을 받지 않습니다. 스페셜은 직접 피격 대상에서 제외합니다.</p>`;
    const colors=UNIT_COLORS;
    $('health-graph').innerHTML=`<svg viewBox="0 0 900 170" role="img" aria-label="평균 경로 학생별 HP 비율 변화"><path d="M58,18H880M58,140H880" stroke="${INK.grid}"/><text x="48" y="22" text-anchor="end" font-size="13" fill="${INK.axis}">100%</text><text x="48" y="144" text-anchor="end" font-size="13" fill="${INK.axis}">0%</text>${mains.map((m,i)=>`<path d="${mean.timeline.map((p,index)=>{const u=p.health[m.student.Id];return `${index?'L':'M'}${(58+p.time/r.duration*822).toFixed(2)},${(140-(u?.hp??0)/Math.max(u?.max??1,1)*122).toFixed(2)}`;}).join(' ')}" stroke="${colors[i]}" stroke-width="2" fill="none"/>`).join('')}<path id="health-cursor" d="M58,12V140" stroke="${INK.cursor}" opacity=".5"/></svg><div class="chart-legend">${mains.map((m,i)=>`<span><i style="background:${colors[i]}"></i>${esc(m.student.Name)}</span>`).join('')}</div>`;
    $('damage-share').innerHTML = this.runState.members.map(m => `<div><span>${esc(m.student.Name)}</span><meter min="0" max="${Math.max(1, mean.damage)}" value="${mean.contributions[m.student.Id] ?? 0}"></meter><b>${num(mean.contributions[m.student.Id] ?? 0)}</b></div>`).join('');
  }
  renderGraph() {
    const r = this.result, w = 900, h = 260, left = 58, top = 16, bottom = 32;
    const x = t => left + t / r.duration * (w - left - 20), y = d => h - bottom - d / Math.max(r.totalHP, 1) * (h - top - bottom);
    let target = 0;
    $('tactic-graph').innerHTML = `<h3>누적 피해 <small>경과 시간별 · 점선은 페이즈 HP 경계</small></h3><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="경과 시간별 평균, 상위 5% 추정, 이론 고점의 누적 피해 그래프">${r.phases.map(p => { target += p.hp; return `<path d="M${left},${y(target)}H${w - 20}" stroke="${INK.grid}" stroke-dasharray="4 4"/><text x="${left - 7}" y="${y(target) + 4}" text-anchor="end" fill="${INK.axis}" font-size="13">${(target / 1e6).toFixed(1)}M</text>`; }).join('')}${[0, .25, .5, .75, 1].map(f => `<text x="${x(r.duration * f)}" y="${h - 9}" text-anchor="middle" fill="${INK.axis}" font-size="13">${Math.round(r.duration * f)}초</text>`).join('')}${[...r.paths].reverse().map(p => { const points = [...p.timeline]; if (p.clearTime !== null) points.push({ time: r.duration, damage: p.damage }); return `<path d="${points.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(2)},${y(p.damage).toFixed(2)}`).join(' ')}" stroke="${CASE_COLOR[p.key]}" fill="none" stroke-width="2.5"/>`; }).join('')}${r.paths[0].events.filter(e => e.actionId !== undefined && e.type === 'cast').map((e, i) => `<g data-event-time="${e.time}" style="cursor:pointer"><title>${esc(seconds(e.time) + ' · ' + e.label.replaceAll(' → ', ' > '))}</title><path d="M${x(e.time)},${top}V${h-bottom}" stroke="${INK.grid}" stroke-dasharray="2 4"/><circle cx="${x(e.time)}" cy="${top + 8 + i % 3 * 14}" r="5" fill="${INK.cursor}"/></g>`).join('')}<path id="graph-cursor" d="M${left},${top}V${h - bottom}" stroke="${INK.cursor}" opacity=".5"/></svg><div class="chart-legend">${CASES.map(c => `<span><i style="background:${CASE_COLOR[c.key]}"></i>${esc(c.label)}</span>`).join('')}</div>`;
  }
  renderTime() {
    if (!this.result) return;
    const time = Number($('time-cursor').value), mean = this.result.paths[0], point = pointAt(mean, time);
    $('graph-cursor').setAttribute('transform', `translate(${time / this.result.duration * 822},0)`);
    this.result.paths.forEach((path, i) => {
      const p = pointAt(path, time), line = $('case-summary').children[i]?.querySelector('.at-cursor');
      if (line) line.innerHTML = `이 시각 <b>${num(p.damage)}</b> 피해 · ${path.clearTime !== null && time >= path.clearTime ? '클리어' : `${p.phase + 1}페이즈 · 잔여 ${num(p.remaining)} HP`}`;
    });
    const recent = mean.events.filter(e => e.time <= time).slice(-12).reverse();
    $('timeline-events').innerHTML = recent.map(e => `<li class="event-${e.type}"><time>${seconds(e.time)}</time><span>${label(e.label)}</span>${e.type === 'cast' ? `<small>코스트 ${e.beforeCost.toFixed(2)}${ARROW}${e.cost.toFixed(2)} (−${e.spent})</small>` : ''}</li>`).join('') || '<li>아직 행동이 없습니다. 시간을 이동하거나 재생하세요.</li>';
    const { members, data, prepared, corrections } = this.runState;
    const phase = this.result.phases[Math.min(point.phase, this.result.phases.length - 1)];
    $('active-buffs').innerHTML = members.map(m => {
      const context = teamContext(members, m.student.Id, mean.records, { ...phase.enemy, ...corrections, time, currentTargetId: m.student.Id }, data, true, prepared);
      const active = context.activeBuffs.filter(b => b.type !== 'Passive');
      return `<div><strong>${esc(m.student.Name)}</strong><span>${active.map(b => `${esc(b.label)}${Number.isFinite(b.end) ? ` · 잔여 ${Math.max(0, b.end - time).toFixed(1)}초` : ''}`).join('<br>') || '활성 스킬 버프 없음'}</span></div>`;
    }).join('');
    this.renderPalette();
    $('cost-cursor')?.setAttribute('transform', `translate(${time / this.result.duration * 822},0)`);
    $('health-cursor')?.setAttribute('transform',`translate(${time/this.result.duration*822},0)`);
    $('health-readout').innerHTML=this.runState.members.filter(m=>m.student.SquadType==='Main').map(m=>{
      const u=point.health?.[m.student.Id],dead=u?.deadAt!==null&&u?.deadAt!==undefined;
      return `<div class="${dead?'dead':'alive'}"><strong>${esc(m.student.Name)}</strong><span>${dead?`${seconds(u.deadAt)} 사망`:`HP ${num(u?.hp??0)} / ${num(u?.max??0)}`}</span><meter min="0" max="${u?.max??1}" value="${u?.hp??0}"></meter><small>보호막 ${num(u?.shield??0)}</small></div>`;
    }).join('');
    $('plan-playhead')?.style.setProperty('left', `${124 + time / this.result.duration * Math.max(500, this.result.duration * (Number($('timeline-zoom').value) || 8))}px`);
    $('plan-clock').textContent = `${seconds(time)} / ${seconds(this.result.duration)}`;this.renderQuick();
  }
  stop() { if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null; this.setPlayState(false); }
  setPlayState(playing) { $('plan-play').textContent = playing ? '일시정지' : '재생'; $('plan-play').setAttribute('aria-pressed', playing); }
  showResultTab(key) {
    for (const tab of $('tactic-results').querySelectorAll('[data-result-tab]')) { const on = tab.dataset.resultTab === key; tab.setAttribute('aria-selected', on); tab.tabIndex = on ? 0 : -1; }
    for (const pane of $('tactic-results').querySelectorAll('[data-result-pane]')) pane.hidden = pane.dataset.resultPane !== key;
  }
  play() {
    if (!this.result) return;
    if (Number($('time-cursor').value) >= this.result.duration) $('time-cursor').value = 0;
    this.setPlayState(true); let previous = performance.now(), drawn = 0;
    const step = now => {
      const value = Math.min(this.result.duration, Number($('time-cursor').value) + (now - previous) / 1000 * 4); previous = now;
      $('time-cursor').value = value;
      if (now - drawn >= 100) { this.renderTime(); drawn = now; }
      if (value >= this.result.duration) { this.renderTime(); this.stop(); return; }
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }
}
