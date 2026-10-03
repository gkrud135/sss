import { enemyActions } from './battle.mjs';
import { randomBossPlan } from './boss-random.mjs';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const opts=(rows,value)=>rows.map(([key,label])=>`<option value="${esc(key)}" ${String(key)===String(value)?'selected':''}>${esc(label)}</option>`).join('');

export class EnemyUI {
  constructor(getState,changed) {
    this.getState=getState;this.changed=changed;this.manual=[];this.generated=[];this.selected=0;this.signature='';this.saved=new Map();
    this.seed=crypto.getRandomValues(new Uint32Array(1))[0];this.patternKey='';this.phases=[];
    for(const id of ['boss-pattern-mode','boss-pattern-interval']) $(id).addEventListener('change',()=>{this.refresh(this.phases);this.render();changed();});
    $('boss-reroll').addEventListener('click',()=>{this.seed=crypto.getRandomValues(new Uint32Array(1))[0];this.refresh(this.phases);changed();});
    $('enemy-action-add').addEventListener('click',()=>{
      const state=getState(),actor=state.enemy.character,choices=enemyActions(state.raidData,state.enemy);
      if(!actor||!choices.length)return;
      this.plan.push({enemyId:actor.Id,skillId:choices[0].key,effectIndex:0,time:this.plan.length?this.plan.at(-1).time+10:10,
        delay:0,repeat:false,interval:15,targetIds:state.members.filter(m=>m.student.SquadType==='Main').map(m=>m.student.Id),
        buffDuration:30,phase:0,damageMultiplier:100,stateDuration:0,bossReceived:100});
      this.selected=this.plan.length-1;this.render();changed();
    });
    $('enemy-action-editor').addEventListener('input',event=>{
      const field=event.target.dataset.field;if(!field||!this.plan[this.selected])return;
      const a=this.plan[this.selected];
      if(field==='targetId') {
        const id=Number(event.target.value);a.targetIds=event.target.checked?[...new Set([...a.targetIds,id])]:a.targetIds.filter(x=>x!==id);
      }else if(field==='repeat')a.repeat=event.target.checked;
      else if(field==='enemyId'){a.enemyId=Number(event.target.value);a.skillId=enemyActions(getState().raidData,{character:getState().raidData.enemies[String(a.enemyId)]})[0]?.key;a.effectIndex=0;this.render();}
      else if(field==='skillId'){a.skillId=event.target.value;a.effectIndex=0;this.render();}
      else a[field]=Math.max(0,Number(event.target.value));
      changed();
    });
    $('enemy-action-editor').addEventListener('click',event=>{
      if(event.target.closest('[data-enemy-remove]')){this.plan.splice(this.selected,1);this.selected=Math.max(0,this.selected-1);this.render();changed();}
    });
    $('incoming-mode').addEventListener('change',changed);
  }
  get random(){return $('boss-pattern-mode').value==='random';}
  get plan(){return this.random?this.generated:this.manual;}
  refresh(phases){
    this.phases=phases;
    const s=this.getState(),key=JSON.stringify([s.raid?.Id,s.difficulty,phases.map(p=>p.enemy.character?.Id),s.members.map(m=>m.student.Id),Number($('sim-duration').value),Number($('boss-pattern-interval').value),this.seed]);
    if(key!==this.patternKey){this.patternKey=key;this.generated=randomBossPlan({...s,phases,duration:Number($('sim-duration').value),interval:Number($('boss-pattern-interval').value),seed:this.seed});}
    $('manual-enemy-settings').hidden=this.random;
    $('boss-pattern-interval').disabled=!this.random;$('boss-reroll').disabled=!this.random||!s.enemy.character;
    $('boss-random-note').textContent=this.random?'실험용: 실제 AI 조건·확률과 다른 임의 순서·간격입니다.':'보스 AI의 발동 조건·시간표는 미검증입니다. 실전 패턴 시각과 대상을 직접 배치하세요. 패턴을 넣어야 생존을 추정할 수 있습니다.';
  }
  sync() {
    const s=this.getState(),signature=`${s.battleKey??''}:${s.raid?.Id}:${s.difficulty}`;
    if(signature!==this.signature){if(this.signature)this.saved.set(this.signature,this.manual);this.signature=signature;this.manual=this.saved.get(signature)??[];this.selected=0;}
    $('enemy-action-add').disabled=!s.enemy.character;
    this.render();
  }
  select(index){this.selected=index;this.render();}
  render() {
    const {members,raidData,enemy}=this.getState(),a=this.plan[this.selected];
    $('enemy-action-editor').innerHTML=a?this.form(a,members,raidData):'<p class="helper">보스 패턴을 추가해 발동 시각과 공격 대상을 정하세요. 원본에 AI 시간표가 없어 시각은 직접 설정합니다.</p>';
    const actor=a?raidData.enemies[String(a.enemyId)]:enemy.character;
    $('enemy-pattern-list').innerHTML=actor?enemyActions(raidData,{character:actor}).map(({key,skill})=>{
      const desc=raidData.raidSkills[key]??Object.values(raidData.raidSkills).find(s=>s.Name===skill.Name);
      return `<div><strong>${esc(skill.Name)}</strong><p>${esc(desc?.Desc?.replace(/<[^>]*>/g,'').replace(/\/\n/g,'\n')??'발동 시간과 대상은 직접 배치합니다.')}</p></div>`;
    }).join(''):'';
  }
  form(a,members,raidData){
    const actor=raidData.enemies[String(a.enemyId)],choices=enemyActions(raidData,{character:actor}),skill=raidData.enemySkills[a.skillId];
    const state=this.getState(),actors=(state.raid?.EnemyList[state.difficulty]??[a.enemyId]).map(id=>raidData.enemies[String(id)]).filter(e=>e&&!e.IsNPC&&enemyActions(raidData,{character:e}).length);
    const effects=(skill?.Effects??[]).flatMap((e,index)=>['Damage','DamageDebuff','CrowdControl'].includes(e.Type)?[[index,
      `${index+1}번 · ${e.Type==='CrowdControl'?(e.Icon==='Stunned'?'기절':'제어'):e.Type==='DamageDebuff'?'지속 피해':'피해'}${e.Type==='Damage'?` · ${(Array.isArray(e.Scale?.[0])?e.Scale[0][0]:e.Scale?.[0]??0)/100}% · ${e.Hits?.length??1}타`:''}${e.Group!==undefined?` · 구분 ${e.Group}`:''}`]]:[]);
    return `<div class="enemy-inspector"><div class="editor-heading"><h3>선택한 보스 패턴 ${this.selected+1}</h3><button type="button" data-enemy-remove class="tiny-button">패턴 삭제</button></div><div class="field-grid"><label>패턴 시전자<select data-field="enemyId">${opts(actors.map(e=>[e.Id,e.Name]),a.enemyId)}</select></label><label>실제 스킬<select data-field="skillId">${opts(choices.map(e=>[e.key,e.skill.Name]),a.skillId)}</select></label><label>계산할 공격 / 기믹 효과<select data-field="effectIndex">${opts(effects.length?effects:[[0,'디버프 / 상태 효과']],a.effectIndex)}</select></label><label>발동 시각 (초)<input type="number" min="0" step=".1" data-field="time" value="${a.time}"></label><label>공격 적용 지연 (초)<input type="number" min="0" step=".1" data-field="delay" value="${a.delay}"></label><label>공격 피해 추가 배율 (%)<input type="number" min="0" data-field="damageMultiplier" value="${a.damageMultiplier}"></label><label>디버프 지속 (초, 0=상시)<input type="number" min="0" step=".1" data-field="buffDuration" value="${a.buffDuration}"></label><label>발동 페이즈 (0=모든 페이즈)<input type="number" min="0" step="1" data-field="phase" value="${a.phase}"></label><label>반복 간격 (초)<input type="number" min=".1" step=".1" data-field="interval" value="${a.interval}"></label></div><label class="check"><input data-field="repeat" type="checkbox" ${a.repeat?'checked':''}>이 패턴 반복</label><div class="enemy-targets"><strong>이 공격 / 디버프에 맞는 학생</strong>${members.filter(m=>m.student.SquadType==='Main').map(m=>`<label class="check"><input type="checkbox" data-field="targetId" value="${m.student.Id}" ${a.targetIds.includes(m.student.Id)?'checked':''}>${esc(m.student.Name)}</label>`).join('')}</div><details class="tactic-editor"><summary>기믹 상태의 수동 보정</summary><p class="helper">성배·게이지·그로기 등을 직접 지정합니다. 기본 보스 피해 감소에 추가로 곱하며, 0%는 해당 시간 동안 무적입니다.</p><div class="field-grid"><label>보스가 받는 피해 (%)<input type="number" min="0" data-field="bossReceived" value="${a.bossReceived}"></label><label>이 상태 지속 (초, 0=보정 끄기)<input type="number" min="0" step=".1" data-field="stateDuration" value="${a.stateDuration}"></label></div></details></div>`;
  }
}
