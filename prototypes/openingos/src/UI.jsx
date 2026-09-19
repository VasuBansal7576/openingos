import { useEffect, useRef } from 'react';
import { ArrowRight, ArrowUpRight, X, Check, Sparkle, FileText } from '@phosphor-icons/react';
export function Button({ children, secondary = false, className = '', ...props }) { return <button className={`${secondary ? 'button secondary' : 'button'} ${className}`} {...props}>{children}</button>; }
export function Next({ children, ...props }) { return <Button {...props}>{children}<ArrowRight size={19} /></Button>; }
export function Tag({ children, tone = '' }) { return <span className={`tag ${tone}`}>{children}</span>; }
export function Brand({ onClick }) { return <button className="brand" onClick={onClick} aria-label="OpeningOS home">Opening<span>OS</span><span className="brand-dot">.</span></button>; }
export function Empty({ title, children }) { return <section className="empty"><FileText size={34}/><h2>{title}</h2><p>{children}</p></section>; }
export function Heading({ eyebrow, title, children, action }) { return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{children && <p className="lede">{children}</p>}</div>{action}</div>; }
export function Dialog({ title, children, close, wide = false }) {
  const ref = useRef(null);
  useEffect(() => { const element = ref.current; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'wide' : ''}`} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }} aria-labelledby="dialog-title"><div className="dialog-head"><h2 id="dialog-title">{title}</h2><button className="icon-button" onClick={close} aria-label="Close dialog"><X size={23}/></button></div>{children}</dialog>;
}
export function AssistantTrigger({ onClick, text = 'Ask about this decision…' }) { return <button className="assistant-trigger" onClick={onClick}><Sparkle size={21}/><span>{text}</span><ArrowUpRight size={20}/></button>; }
export function Stepper({ current, go }) {
  const steps = [['brief','Brief'],['research','Research'],['compare','Compare'],['review','Decision']];
  const index = steps.findIndex(([id]) => id === current);
  return <nav className="stepper" aria-label="Purchasing steps">{steps.map(([id,label],i) => <button key={id} onClick={() => go(id)} aria-current={current === id ? 'step' : undefined} className={i === index ? 'active' : ''}><span>{i < index ? <Check size={13}/> : i+1}</span>{label}</button>)}</nav>;
}
