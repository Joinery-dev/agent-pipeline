'use client';

import { useCallback, useState, useEffect, memo } from 'react';
import {
  ReactFlow,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import TurboEdge from './TurboEdge';
import styles from './visualize.module.css';

/* ------------------------------------------------------------------ */
/*  Turbo Node                                                          */
/* ------------------------------------------------------------------ */

const TurboNode = memo(({ data }) => {
  // Support both field conventions: title/subline (.goals.json) and label/subtitle (standalone)
  const title = data.title || data.label;
  const subtitle = data.subline || data.subtitle;

  return (
    <>
      <div className={`${styles.wrapper} ${styles.gradient}`}>
        <div className={styles.inner}>
          <div className={styles.body}>
            {data.icon && <div className={styles.icon}>{data.icon}</div>}
            <div className={styles.bodyText}>
              <div className={styles.title}>{title}</div>
              {subtitle && <div className={styles.sub}>{subtitle}</div>}
            </div>
          </div>
          {data.fields && (
            <div className={styles.fields}>
              {data.fields.map((f, i) => (
                <div key={i} className={styles.field}>
                  <span className={styles.fname}>{f.name}</span>
                  <span className={styles.ftype}>{f.type}</span>
                </div>
              ))}
            </div>
          )}
          <Handle type="target" position={Position.Top} />
          <Handle type="source" position={Position.Bottom} />
        </div>
      </div>
    </>
  );
});
TurboNode.displayName = 'TurboNode';

/* ------------------------------------------------------------------ */
/*  Group Node                                                          */
/* ------------------------------------------------------------------ */

function GroupNode({ data }) {
  return (
    <div className={styles.groupNode} data-color={data.color || 'purple'}>
      <div className={styles.groupLabel}>{data.label || data.title}</div>
    </div>
  );
}

const nodeTypes = { turbo: TurboNode, group: GroupNode };
const edgeTypes = { turbo: TurboEdge };
const defaultEdgeOptions = { type: 'turbo', markerEnd: 'edge-circle' };

/* ------------------------------------------------------------------ */
/*  Diagram Viewer — reads from .goals.json                             */
/* ------------------------------------------------------------------ */

export default function DiagramViewer() {
  const [diagrams, setDiagrams] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selected, setSelected] = useState(null);

  // Load diagrams from .goals.json via API
  useEffect(() => {
    fetch('/api/diagrams')
      .then(r => r.json())
      .then(data => {
        setDiagrams(data);
        if (data.length > 0) {
          setNodes(data[0].nodes);
          setEdges(data[0].edges);
        }
      })
      .catch(() => {
        // If no API, try loading from window.__DIAGRAM_DATA__
        if (typeof window !== 'undefined' && window.__DIAGRAM_DATA__) {
          const d = window.__DIAGRAM_DATA__;
          setDiagrams([d]);
          setNodes(d.nodes || []);
          setEdges(d.edges || []);
        }
      });
  }, []);

  // Switch active diagram
  useEffect(() => {
    if (diagrams[activeIndex]) {
      setNodes(diagrams[activeIndex].nodes);
      setEdges(diagrams[activeIndex].edges);
    }
  }, [activeIndex, diagrams]);

  const onNodeClick = useCallback((_, node) => {
    if (node.type === 'group') return;
    setSelected({ type: 'node', ...node.data });
  }, []);

  const onEdgeClick = useCallback((_, edge) => {
    setSelected({
      type: 'edge',
      label: edge.label,
      flow: edge.data?.flow,
      source: edge.source,
      target: edge.target,
    });
  }, []);

  return (
    <div className={styles.container}>
      {/* Diagram selector (if multiple) */}
      {diagrams.length > 1 && (
        <div className={styles.diagramSelector}>
          {diagrams.map((d, i) => (
            <button
              key={d.id}
              className={`${styles.diagramTab} ${i === activeIndex ? styles.diagramTabActive : ''}`}
              onClick={() => setActiveIndex(i)}
            >
              {d.title}
            </button>
          ))}
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => setSelected(null)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={() => '#2a2a3e'}
          maskColor="rgba(0,0,0,0.7)"
          style={{ background: '#111' }}
        />
        <svg>
          <defs>
            <linearGradient id="edge-gradient">
              <stop offset="0%" stopColor="#ae53ba" />
              <stop offset="100%" stopColor="#2a8af6" />
            </linearGradient>
            <marker
              id="edge-circle"
              viewBox="-5 -5 10 10"
              refX="0"
              refY="0"
              markerUnits="strokeWidth"
              markerWidth="10"
              markerHeight="10"
              orient="auto"
            >
              <circle stroke="#2a8af6" strokeOpacity="0.75" r="2" cx="0" cy="0" />
            </marker>
          </defs>
        </svg>
      </ReactFlow>

      {/* Detail Panel */}
      {selected && (
        <div className={styles.detailPanel}>
          <button className={styles.detailClose} onClick={() => setSelected(null)}>✕</button>
          {selected.type === 'edge' && (
            <>
              <div className={styles.detailRoute}>
                <span className={styles.detailChip}>{selected.source}</span>
                <span className={styles.detailArrow}>→</span>
                <span className={styles.detailChip}>{selected.target}</span>
              </div>
              <div className={styles.detailTitle}>{selected.label}</div>
              <div className={styles.detailDesc}>{selected.flow}</div>
            </>
          )}
          {selected.type === 'node' && (
            <>
              <div className={styles.detailTitle}>
                {selected.icon} {selected.title || selected.label}
              </div>
              {(selected.subline || selected.subtitle) && (
                <div className={styles.detailSub}>{selected.subline || selected.subtitle}</div>
              )}
              {selected.detail && <div className={styles.detailDesc}>{selected.detail}</div>}
              {selected.fields && (
                <div className={styles.detailFields}>
                  {selected.fields.map((f, i) => (
                    <div key={i} className={styles.detailFieldRow}>
                      <span className={styles.detailFieldName}>{f.name}</span>
                      <span className={styles.detailFieldType}>{f.type}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
