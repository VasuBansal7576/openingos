import { useEffect, useState } from 'react';
import { ArrowRight, ArrowClockwise, SquaresFour, Coffee, ChatCircle, Truck, Wrench, Storefront, Sparkle, CaretDown } from '@phosphor-icons/react';
import { concepts, initialProject } from './model';
import { Brand, Dialog } from './UI';
import { Gallery, Landing } from './Landing';
import { Compare } from './Compare';
import { Brief, Research, Vendors, Inbox, Review, Decision, Recovery, Equipment, Evidence, Assistant } from './Flow';

const pages = ['gallery','landing','brief','research','compare','vendors','inbox','review','decision','recovery','equipment'];
function readPage(){const route=window.location.hash.replace(/^#\/?/,'');return pages.includes(route)?route:'gallery';}
function readConcept(){return concepts.find(c=>c.id===new URLSearchParams(window.location.search).get('variant'))??concepts[0];}

// Three exploratory interfaces share fixture state, not a production app architecture.
export function App() {
  const [concept,setConcept]=useState(readConcept);
  const [page,setPage]=useState(readPage);
  const [project,setProject]=useState(initialProject);
  const [research,setResearch]=useState('idle');
  const [candidate,setCandidate]=useState('elm');
  const [outreach,setOutreach]=useState('draft');
  const [revised,setRevised]=useState(false);
  const [selection,setSelection]=useState(null);
  const [recovery,setRecovery]=useState('idle');
  const [service,setService]=useState(null);
  const [modal,setModal]=useState(null);
  useEffect(()=>{const sync=()=>{setPage(readPage());setModal(null);window.scrollTo(0,0);};window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[]);
  useEffect(()=>{const sync=()=>setConcept(readConcept());window.addEventListener('popstate',sync);return()=>window.removeEventListener('popstate',sync);},[]);
  useEffect(()=>{document.title=`${concept.name} · OpeningOS prototype`;},[concept]);
  const go=next=>{setPage(next);setModal(null);window.location.hash=`/${next}`;window.scrollTo(0,0);};
  const changeConcept=next=>{const url=new URL(window.location.href);url.searchParams.set('variant',next.id);window.history.replaceState({},'',url);setConcept(next);};
  const choose=id=>{changeConcept(concepts.find(c=>c.id===id));go('landing');};
  const begin=()=>{setResearch('running');go('research');};
  const reset=()=>{setProject(initialProject);setResearch('idle');setCandidate('elm');setOutreach('draft');setRevised(false);setSelection(null);setRecovery('idle');setService(null);go('landing');};
  const workspace=!['gallery','landing'].includes(page);
  const nav=[['compare','Project',Coffee],['vendors','Suppliers',Storefront],['inbox','Inbox',ChatCircle],['recovery','Recovery',Truck],['equipment','Equipment',Wrench]];
  let content;
  if(page==='gallery')content=<Gallery choose={choose}/>;
  if(page==='landing')content=<Landing concept={concept} go={go} start={begin} gallery={()=>go('gallery')}/>;
  if(page==='brief')content=<Brief project={project} setProject={setProject} go={go} begin={begin}/>;
  if(page==='research')content=<Research research={research==='idle'?'done':research} setResearch={setResearch} go={go} project={project}/>;
  if(page==='compare')content=<Compare concept={concept} candidate={candidate} setCandidate={setCandidate} revised={revised} go={go} open={setModal} project={project}/>;
  if(page==='vendors')content=<Vendors revised={revised} go={go} setCandidate={setCandidate} open={setModal}/>;
  if(page==='inbox')content=<Inbox outreach={outreach} setOutreach={setOutreach} revised={revised} setRevised={setRevised} go={go} open={setModal}/>;
  if(page==='review')content=<Review candidate={candidate} revised={revised} project={project} selection={selection} setSelection={setSelection} go={go} open={setModal}/>;
  if(page==='decision')content=<Decision selection={selection} go={go} project={project}/>;
  if(page==='recovery')content=<Recovery recovery={recovery} setRecovery={setRecovery} go={go} project={project}/>;
  if(page==='equipment')content=<Equipment service={service} setService={setService} selection={selection} go={go}/>;
  return <div className={`app theme-${concept.id} page-${page}`}>
    <a className="skip-link" href="#main-content" onClick={event=>{event.preventDefault();document.getElementById('main-content')?.focus();}}>Skip to content</a>
    {workspace&&<><div className="demo-banner"><span><span className="status-dot"/> INTERACTIVE PROTOTYPE</span><span>Fictional data · simulated actions · nothing is sent or purchased</span><button onClick={reset}>Restart demo <ArrowClockwise size={13}/></button></div><header className="app-header"><Brand onClick={()=>go('landing')}/><button className="project-picker" onClick={()=>go('brief')}>{project.name}<CaretDown size={15}/></button><nav aria-label="Workspace navigation">{nav.map(([id,label,Icon])=><button key={id} onClick={()=>go(id)} aria-current={page===id||id==='compare'&&['brief','research','review','decision'].includes(page)?'page':undefined}><Icon size={19}/><span>{label}</span>{id==='inbox'&&revised&&<span className="notification-dot"/>}</button>)}</nav><button className="icon-button" aria-label="Open project assistant" onClick={()=>setModal({type:'chat'})}><Sparkle size={23}/></button></header></>}
    <main id="main-content" tabIndex={-1}>{content}</main>
    {page!=='gallery'&&<div className="prototype-switcher" aria-label="Prototype design switcher"><button className="icon-button" onClick={()=>go('gallery')} aria-label="All three designs"><SquaresFour size={18}/></button><span>DESIGN</span><select aria-label="Choose design" value={concept.id} onChange={event=>changeConcept(concepts.find(c=>c.id===event.target.value))}>{concepts.map((c,i)=><option key={c.id} value={c.id}>{i+1}. {c.name}</option>)}</select><button className="icon-button" aria-label="Next design" onClick={()=>changeConcept(concepts[(concepts.indexOf(concept)+1)%3])}><ArrowRight size={17}/></button></div>}
    {modal&&<Dialog title={modal.type==='evidence'?`${modal.quote.name} · source`: 'Your project assistant'} close={()=>setModal(null)} wide={modal.type==='evidence'}>{modal.type==='evidence'?<Evidence quote={modal.quote} charge={modal.charge}/>:<Assistant revised={revised} go={go} close={()=>setModal(null)}/>}</Dialog>}
  </div>;
}
