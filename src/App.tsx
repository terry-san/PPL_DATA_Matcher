import React, { useState, useEffect, useRef } from 'react';
import { 
  motion, 
  AnimatePresence 
} from 'motion/react';
import { 
  Video, 
  Database, 
  CheckCircle2, 
  Upload, 
  LogIn, 
  LogOut, 
  ChevronRight, 
  Table as TableIcon,
  Search,
  Check,
  Loader2,
  Layers,
  Sparkles,
  ArrowRight,
  ClipboardList,
  Download,
  ShieldCheck,
  History,
  Trash2,
  FileEdit,
  AlertCircle
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from './lib/firebase';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User, 
  signOut 
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  serverTimestamp,
  getDoc,
  doc,
  getDocs,
  deleteDoc,
  query,
  orderBy,
  getDocFromServer
} from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { extractTextFromVideo } from './lib/gemini';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Step = 'auth' | 'video' | 'confirm' | 'database' | 'results' | 'admin';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>('auth');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  
  const [extractedItems, setExtractedItems] = useState<string[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [referenceData, setReferenceData] = useState<any[]>([]);
  const [dbInfo, setDbInfo] = useState<{ name: string; size: number } | null>(null);
  const [results, setResults] = useState<any[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  const handleEditStart = (index: number, value: string) => {
    setEditingIndex(index);
    setEditValue(value);
  };

  const handleEditSave = (index: number) => {
    if (editingIndex === null) return;
    const oldVal = extractedItems[index];
    const newVal = editValue.trim();
    
    if (newVal && newVal !== oldVal) {
      const newItems = [...extractedItems];
      newItems[index] = newVal;
      setExtractedItems(newItems);
      
      if (selectedItems.has(oldVal)) {
        const next = new Set(selectedItems);
        next.delete(oldVal);
        next.add(newVal);
        setSelectedItems(next);
      }
    }
    setEditingIndex(null);
  };

  // Persistence for selections
  useEffect(() => {
    const saved = localStorage.getItem('insight_selected_items');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSelectedItems(new Set(parsed));
      } catch (e) { 
        console.error("Persistence Restore Error", e); 
      }
    }
  }, []);

  useEffect(() => {
    if (selectedItems.size >= 0) {
      localStorage.setItem('insight_selected_items', JSON.stringify(Array.from(selectedItems)));
    }
  }, [selectedItems]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        setStep('video');
      } else {
        setStep('auth');
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setStep('auth');
  };

  const generateResults = () => {
    // Preserve the order appearing in the extracted items list
    const finalSelection = extractedItems.filter(item => selectedItems.has(item));
    const matchedIndicesInDB = new Set<number>();
    
    // Advanced Partial Matching + Aggregation Logic
    const matchedResults = finalSelection.map((item) => {
      const itemLower = item.toLowerCase();
      
      // Step 1: Try Exact or Inclusion Match (tracking original DB indices)
      let matchingRows = referenceData.map((row, index) => ({ row, index })).filter(({ row }) => {
        const keys = Object.keys(row);
        if (keys.length === 0) return false;
        const keyVal = String(row[keys[0]] || "").toLowerCase();
        return keyVal.includes(itemLower) || itemLower.includes(keyVal);
      });

      // Step 2: Try Fuzzy/Partial Match if nothing found
      if (matchingRows.length === 0) {
        const parts = item.split(/[\(\[\{\/]/)[0].trim().toLowerCase();
        if (parts.length > 2) {
          matchingRows = referenceData.map((row, index) => ({ row, index })).filter(({ row }) => {
            const keys = Object.keys(row);
            if (keys.length === 0) return false;
            const keyVal = String(row[keys[0]] || "").toLowerCase();
            return keyVal.includes(parts) || parts.includes(keyVal);
          });
        }
      }

      if (matchingRows.length > 0) {
        // Track indices that were matched
        matchingRows.forEach(m => matchedIndicesInDB.add(m.index));
        const matches = matchingRows.map(m => m.row);

        const consolidated: any = {};
        matches.forEach(m => {
          Object.entries(m).forEach(([k, v], idx) => {
            if (idx === 0) return; // Skip key column
            const safeKey = k.replace(/\./g, '_');
            if (!consolidated[safeKey]) consolidated[safeKey] = new Set();
            const valStr = String(v).trim();
            if (valStr && valStr.toLowerCase() !== "n/a") {
              consolidated[safeKey].add(valStr);
            }
          });
        });

        const details: any = {};
        Object.entries(consolidated).forEach(([k, v]: [string, any]) => {
          const vals = Array.from(v);
          if (vals.length > 0) {
            details[k] = vals.join(" | ");
          }
        });

        const sources = Array.from(new Set(matches.map(m => String(m[Object.keys(m)[0]]))));
        details["Matched Reference(s)"] = sources.join(", ");

        return { item, details, status: 'MATCHED' as const };
      }

      return {
        item,
        details: { Status: 'No significant match identified' },
        status: 'MISMATCH' as const
      };
    });

    // Identify all database rows that were NOT identified during the extraction matching
    const unmatchedEntriesInDB = referenceData
      .map((row, index) => ({ row, index }))
      .filter(({ index }) => !matchedIndicesInDB.has(index))
      .map(({ row }) => {
        const keys = Object.keys(row);
        const colA = String(row[keys[0]] || "N/A");
        
        // Pass through all original columns for consistent Excel output
        const details: any = {};
        keys.forEach((k, idx) => {
          if (idx === 0) return; // Skip key column in details as it's the "item"
          const safeKey = k.replace(/\./g, '_');
          details[safeKey] = row[k] || "N/A";
        });

        return {
          item: colA, // Use clean value for 'Extracted Entity' column
          details: details,
          status: 'UNMATCHED_DB' as const
        };
      });

    setResults([...matchedResults, ...unmatchedEntriesInDB]);
    setStep('results');
  };

  const exportExcel = () => {
    const data = results.map((r, i) => ({
      "SR #": i + 1,
      "Extracted Entity": r.item,
      "Status": r.status,
      ...r.details
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Analysis_Results");
    XLSX.writeFile(wb, `Analysis_Report_${new Date().getTime()}.xlsx`);
  };

  if (loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <Loader2 className="animate-spin text-indigo-600 w-8 h-8" />
    </div>
  );

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans">
      {connectionError && (
        <div className="bg-red-600 text-white text-[10px] py-1 text-center font-black uppercase tracking-widest fixed top-0 w-full z-50">
          {connectionError}
        </div>
      )}
      <nav className="sticky top-0 z-40 w-full bg-white/80 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-2 cursor-pointer" onClick={() => user && setStep('video')}>
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-200 transition-transform active:scale-90">
              <Layers className="text-white w-5 h-5" />
            </div>
            <span className="font-bold text-xl tracking-tight text-slate-800">InsightMapper</span>
          </div>
          
          <div className="flex items-center space-x-6">
            {user && (
              <div className="flex items-center space-x-4">
                <button 
                  onClick={handleLogout}
                  className="text-xs font-black uppercase tracking-widest text-slate-400 hover:text-red-600 flex items-center space-x-1"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Exit Session</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <AnimatePresence mode="wait">
          {step === 'auth' && (
            <motion.div 
              key="auth"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="mt-20 flex flex-col items-center"
            >
              <div className="max-w-md w-full bg-white rounded-3xl p-10 shadow-xl shadow-slate-200 border border-slate-100 text-center">
                <div className="w-20 h-20 bg-indigo-50 rounded-2xl flex items-center justify-center mx-auto mb-8 text-indigo-600 ring-4 ring-white shadow-inner">
                  <Sparkles className="w-10 h-10" />
                </div>
                <h2 className="text-4xl font-black text-slate-900 mb-4 tracking-tighter italic uppercase">Analytics Gate</h2>
                <p className="text-slate-500 mb-12 font-medium leading-relaxed">
                  Enterprise-grade video frame analysis and record matching for mission-critical logistics and inventory.
                </p>
                <button 
                  onClick={handleLogin}
                  className="w-full flex items-center justify-center space-x-3 bg-indigo-600 text-white px-8 py-5 rounded-2xl font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-2xl shadow-indigo-100"
                >
                  <LogIn className="w-5 h-5" />
                  <span>Authenticate Access</span>
                </button>
              </div>
            </motion.div>
          )}

          {(step !== 'auth') && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-8"
            >
              <div className="flex items-center justify-between px-6 py-3 bg-white rounded-3xl border border-slate-200 shadow-sm overflow-x-auto no-scrollbar scroll-smooth">
                <StepIndicator current={step} target="video" icon={<Video className="w-4 h-4" />} label="Stream" />
                <ChevronRight className="w-4 h-4 text-slate-200 shrink-0" />
                <StepIndicator current={step} target="confirm" icon={<CheckCircle2 className="w-4 h-4" />} label="Verify" />
                <ChevronRight className="w-4 h-4 text-slate-200 shrink-0" />
                <StepIndicator current={step} target="database" icon={<Database className="w-4 h-4" />} label="Database" />
                <ChevronRight className="w-4 h-4 text-slate-200 shrink-0" />
                <StepIndicator current={step} target="results" icon={<TableIcon className="w-4 h-4" />} label="Analysis" />
              </div>

              {step === 'video' && (
                <div className="space-y-6">
                  <SectionTitle title="Media Intelligence" subtitle="System scans temporal nodes for unique textual identifiers." />
                  <div className="bg-white rounded-[40px] p-10 border border-slate-200 shadow-sm">
                    <VideoUploader 
                      onExtracted={(items) => {
                        setExtractedItems(items);
                        // PERSISTENCE: Items are merged with selected if coming from a new scan
                        const current = new Set(selectedItems);
                        items.forEach(i => current.add(i));
                        setSelectedItems(current);
                        setStep('confirm');
                      }}
                      setIsProcessing={setIsProcessing}
                    />
                  </div>
                </div>
              )}

              {step === 'confirm' && (
                <div className="space-y-6">
                  <SectionTitle title="Identity Validation" subtitle={`Parsed ${extractedItems.length} unique nodes. Select items for cross-reference.`} />
                  <div className="bg-white rounded-[40px] p-10 border border-slate-200 shadow-sm">
                    <div className="flex flex-col gap-3 mb-10 max-h-[50vh] overflow-y-auto p-4 border-2 border-slate-50 rounded-3xl">
                      {extractedItems.map((item, idx) => (
                        <div 
                          key={idx}
                          className={cn(
                            "group p-5 rounded-2xl border-2 transition-all flex items-center justify-between",
                            selectedItems.has(item) 
                              ? "border-indigo-600 bg-indigo-50 shadow-md shadow-indigo-50/50" 
                              : "border-slate-50 bg-white"
                          )}
                        >
                          <div className="flex items-center space-x-6 flex-1">
                            <button 
                              onClick={() => {
                                const next = new Set(selectedItems);
                                if (next.has(item)) next.delete(item);
                                else next.add(item);
                                setSelectedItems(next);
                              }}
                              className={cn(
                                "w-8 h-8 rounded-xl flex items-center justify-center transition-all shrink-0",
                                selectedItems.has(item) ? "bg-indigo-600 text-white" : "bg-slate-50 text-slate-300 border border-slate-100"
                              )}
                            >
                              {selectedItems.has(item) && <Check className="w-5 h-5" />}
                            </button>

                            {editingIndex === idx ? (
                              <div className="flex-1 flex items-center space-x-3">
                                <input 
                                  autoFocus
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleEditSave(idx);
                                    if (e.key === 'Escape') setEditingIndex(null);
                                  }}
                                  className="flex-1 bg-white border-2 border-indigo-400 rounded-xl px-4 py-2 text-lg font-black italic uppercase outline-none focus:ring-4 focus:ring-indigo-100 transition-all font-sans"
                                />
                                <button 
                                  onClick={() => handleEditSave(idx)}
                                  className="bg-indigo-600 text-white p-2 rounded-xl shadow-lg shadow-indigo-100 hover:scale-105 active:scale-95 transition-transform"
                                >
                                  <Check className="w-5 h-5" />
                                </button>
                                <button 
                                  onClick={() => setEditingIndex(null)}
                                  className="text-slate-400 p-2 hover:text-slate-600 transition-colors"
                                >
                                  <AlertCircle className="w-5 h-5 rotate-45" />
                                </button>
                              </div>
                            ) : (
                              <span 
                                onClick={() => {
                                  const next = new Set(selectedItems);
                                  if (next.has(item)) next.delete(item);
                                  else next.add(item);
                                  setSelectedItems(next);
                                }}
                                className={cn(
                                  "font-black text-xl italic uppercase tracking-tight flex-1 cursor-pointer truncate",
                                  selectedItems.has(item) ? "text-indigo-900" : "text-slate-400"
                                )}
                              >
                                {item}
                              </span>
                            )}
                          </div>

                          {editingIndex !== idx && (
                            <div className="flex items-center space-x-2 ml-4 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button 
                                onClick={() => handleEditStart(idx, item)}
                                className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-white rounded-xl transition-all shadow-sm border border-transparent hover:border-slate-100"
                              >
                                <FileEdit className="w-5 h-5" />
                              </button>
                              <button 
                                onClick={() => {
                                  if (!confirm("Permanently discard this node?")) return;
                                  const next = [...extractedItems];
                                  next.splice(idx, 1);
                                  setExtractedItems(next);
                                  if (selectedItems.has(item)) {
                                    const nextSel = new Set(selectedItems);
                                    nextSel.delete(item);
                                    setSelectedItems(nextSel);
                                  }
                                }}
                                className="p-3 text-slate-300 hover:text-red-500 hover:bg-white rounded-xl transition-all shadow-sm border border-transparent hover:border-slate-100"
                              >
                                <Trash2 className="w-5 h-5" />
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between items-center border-t border-slate-100 pt-8">
                      <button onClick={() => setStep('video')} className="text-sm font-black text-slate-400 hover:text-indigo-600 uppercase tracking-widest">Abort Scan</button>
                      <button 
                        onClick={() => setStep('database')}
                        disabled={selectedItems.size === 0}
                        className="bg-indigo-600 text-white px-10 py-4 rounded-2xl font-black uppercase tracking-widest hover:bg-indigo-700 disabled:opacity-50 flex items-center space-x-3 shadow-2xl shadow-indigo-100 transition-transform active:scale-95"
                      >
                        <span>Configure Matrix</span>
                        <ArrowRight className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {step === 'database' && (
                <div className="space-y-6">
                  <SectionTitle title="Master Configuration" subtitle="Define the source-of-truth for reference mapping." />
                  <div className="bg-white rounded-[40px] p-10 border border-slate-200 shadow-sm space-y-10">
                    <DatabaseUploader 
                      onDataLoaded={(data, name) => {
                        setReferenceData(data);
                        setDbInfo({ name, size: data.length });
                      }}
                      currentDataLength={referenceData.length}
                    />
                    
                    {dbInfo && (
                      <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="p-6 bg-indigo-600 rounded-3xl flex items-center justify-between text-white shadow-xl shadow-indigo-100">
                        <div className="flex items-center space-x-4">
                          <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center">
                            <TableIcon className="w-7 h-7" />
                          </div>
                          <div>
                            <p className="text-xs font-black opacity-60 uppercase tracking-widest mb-1">Active Catalog</p>
                            <p className="text-xl font-black italic">{dbInfo.name}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-black">{dbInfo.size.toLocaleString()}</p>
                          <p className="text-[10px] font-black opacity-60 uppercase">Records Ready</p>
                        </div>
                      </motion.div>
                    )}

                    <div className="flex justify-between items-center border-t border-slate-100 pt-8">
                      <button onClick={() => setStep('confirm')} className="text-sm font-black text-slate-400 hover:text-indigo-600 uppercase tracking-widest">Adjust Entities</button>
                      <button 
                        onClick={() => generateResults()}
                        disabled={referenceData.length === 0}
                        className="bg-slate-900 text-white px-16 py-4 rounded-2xl font-black uppercase tracking-widest hover:bg-black disabled:opacity-50 shadow-2xl transition-all active:scale-95"
                      >
                        Execute Match
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {step === 'results' && (
                <div className="space-y-6">
                  <SectionTitle title="Analytical Matrix" subtitle="Consolidated report mapping extractions to reference points." />
                  <div className="bg-white rounded-[40px] border border-slate-200 shadow-sm overflow-hidden border">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Source Entity</th>
                            <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Reference Specification</th>
                            <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Integrity</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {results.map((row, idx) => {
                            const isMatched = row.status === 'MATCHED';
                            return (
                              <tr key={idx} className="hover:bg-indigo-50/20 transition-colors group">
                                <td className="px-8 py-8 align-top">
                                  <div className="flex items-center space-x-4">
                                    <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400 font-mono text-sm font-black">
                                      {idx + 1}
                                    </div>
                                    <span className="font-black text-slate-800 text-xl tracking-tight italic uppercase">{row.item}</span>
                                  </div>
                                </td>
                                <td className="px-8 py-8">
                                  <div className="grid grid-cols-1 gap-4">
                                    {Object.entries(row.details).map(([k, v], i) => (
                                      <div key={i} className="flex flex-col p-4 bg-white border border-slate-100 rounded-2xl shadow-sm">
                                        <span className="text-[10px] text-indigo-400 font-black uppercase mb-1 tracking-widest">{k}</span>
                                        <span className="text-sm font-bold text-slate-700 leading-relaxed">{String(v)}</span>
                                      </div>
                                    ))}
                                  </div>
                                </td>
                                <td className="px-8 py-8 text-right align-top">
                                  {row.status === 'MATCHED' ? (
                                    <span className="inline-flex items-center px-4 py-1.5 bg-green-50 text-green-700 text-[10px] font-black rounded-full border border-green-200 shadow-sm uppercase tracking-widest">
                                      <Check className="w-3 h-3 mr-1" />
                                      Verified
                                    </span>
                                  ) : row.status === 'UNMATCHED_DB' ? (
                                    <span className="inline-flex items-center px-4 py-1.5 bg-amber-50 text-amber-700 text-[10px] font-black rounded-full border border-amber-200 uppercase tracking-widest">
                                      <Database className="w-3 h-3 mr-1" />
                                      DB Entry
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center px-4 py-1.5 bg-slate-50 text-slate-400 text-[10px] font-black rounded-full border border-slate-200 uppercase tracking-widest">
                                      <AlertCircle className="w-3 h-3 mr-1" />
                                      Missing
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="flex justify-between items-center py-10">
                    <button 
                      onClick={() => setStep('video')}
                      className="flex items-center space-x-2 text-slate-400 font-black uppercase tracking-widest hover:text-indigo-600 transition-colors"
                    >
                      <History className="w-5 h-5" />
                      <span>Start New Analysis</span>
                    </button>
                    <div className="flex space-x-4">
                      <button 
                        onClick={exportExcel}
                        className="bg-white border-2 border-slate-200 text-slate-700 px-8 py-4 rounded-2xl font-black uppercase tracking-widest flex items-center space-x-2 hover:bg-slate-50 transition-all"
                      >
                        <Download className="w-5 h-5" />
                        <span>Export Excel</span>
                      </button>
                      <button 
                        onClick={async () => {
                          if (!user) return;
                          try {
                            await addDoc(collection(db, 'extractions'), {
                              userId: user.uid,
                              createdAt: serverTimestamp(),
                              items: results.map(r => r.item),
                              results: results,
                              dbName: dbInfo?.name || "Manual"
                            });
                            alert("Stored successfully in the organizational ledger.");
                          } catch (error) {
                            handleFirestoreError(error, OperationType.WRITE, 'extractions');
                          }
                        }}
                        className="bg-slate-900 text-white px-10 py-4 rounded-2xl font-black uppercase tracking-widest flex items-center space-x-2 shadow-2xl transition-all hover:scale-105 active:scale-95"
                      >
                        <CheckCircle2 className="w-5 h-5" />
                        <span>Archive Data</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="mt-40 border-t border-slate-200 bg-white/50 py-20 text-center">
        <div className="flex justify-center space-x-12 mb-8 opacity-20 filter grayscale">
          <Layers className="w-8 h-8" />
          <Database className="w-8 h-8" />
          <ShieldCheck className="w-8 h-8" />
        </div>
        <p className="text-slate-400 text-xs font-black tracking-[0.3em] uppercase">Enterprise Insight Systems © 2026</p>
      </footer>
    </div>
  );
}

function VideoUploader({ onExtracted, setIsProcessing }: { onExtracted: (items: string[]) => void, setIsProcessing: (val: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected && selected.type.startsWith('video/')) {
      setFile(selected);
      setPreview(URL.createObjectURL(selected));
      setError(null);
    } else {
      setError("Please provide a valid video stream.");
    }
  };

  const processVideo = async () => {
    if (!file) return;
    
    // Safety check for file size (Gemini inlineData limit is roughly 20MB, we'll cap at 15MB for safety)
    if (file.size > 15 * 1024 * 1024) {
      setError("File is too large (>15MB). Please try a shorter or lower resolution clip.");
      return;
    }

    setIsProcessing(true);
    setError(null);
    try {
      // Helper to convert File to Base64
      const convertToBase64 = (file: File): Promise<string> => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.readAsDataURL(file);
          reader.onload = () => {
            const result = reader.result as string;
            resolve(result.split(',')[1]); // Remove data:mime/type;base64,
          };
          reader.onerror = error => reject(error);
        });
      };

      const base64 = await convertToBase64(file);
      const items = await extractTextFromVideo(base64, file.type);
      
      // Clean and distill the items
      const cleanedItems = items
        .map(i => i.trim())
        .filter(i => i.length > 1);
      
      if (cleanedItems.length === 0) {
        throw new Error("No text items could be identified in the footage.");
      }

      onExtracted(Array.from(new Set(cleanedItems)));
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Analysis failed. System overflow.");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex flex-col items-center">
      {preview ? (
        <div className="w-full space-y-8">
          <div className="relative aspect-video rounded-3xl overflow-hidden bg-slate-900 border-8 border-slate-50 shadow-2xl">
            <video src={preview} controls className="w-full h-full object-contain" />
          </div>
          <div className="flex justify-center space-x-4">
            <button 
              onClick={() => { setFile(null); setPreview(null); }}
              className="px-8 py-4 text-xs font-black uppercase text-slate-400 hover:text-red-500"
            >
              Reset Stream
            </button>
            <button 
              onClick={processVideo}
              className="bg-indigo-600 text-white px-12 py-4 rounded-2xl font-black uppercase tracking-widest hover:bg-indigo-700 shadow-2xl shadow-indigo-100 flex items-center space-x-3 transition-transform active:scale-95"
            >
              <Sparkles className="w-5 h-5" />
              <span>Initiate Deep Scan</span>
            </button>
          </div>
        </div>
      ) : (
        <div 
          onClick={() => fileInputRef.current?.click()}
          className="w-full h-80 border-4 border-dashed border-slate-100 rounded-[40px] flex flex-col items-center justify-center cursor-pointer hover:bg-slate-50 hover:border-indigo-200 transition-all group"
        >
          <input ref={fileInputRef} type="file" className="hidden" accept="video/*" onChange={handleFileChange} />
          <div className="w-20 h-20 bg-slate-50 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform text-slate-400 group-hover:text-indigo-600">
            <Upload className="w-10 h-10" />
          </div>
          <h3 className="text-xl font-black text-slate-800 uppercase italic">Ingest Media Stream</h3>
          <p className="text-[10px] text-slate-400 mt-4 font-black uppercase tracking-[0.3em]">MP4 / MOV / WEBM</p>
        </div>
      )}
      {error && <p className="mt-4 text-xs font-black text-red-500 uppercase tracking-widest text-center">{error}</p>}
    </div>
  );
}

function StepIndicator({ current, target, icon, label }: { current: string, target: string, icon: React.ReactNode, label: string }) {
  const active = current === target;
  return (
    <div className={cn(
      "flex items-center space-x-3 px-6 py-3 rounded-2xl transition-all shrink-0",
      active ? "bg-indigo-600 text-white shadow-xl shadow-indigo-100 scale-110" : "text-slate-300"
    )}>
      {icon}
      <span className="text-xs font-black uppercase tracking-widest">{label}</span>
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string, subtitle: string }) {
  return (
    <div className="space-y-2">
      <h2 className="text-4xl font-black text-slate-900 tracking-tighter italic uppercase">{title}</h2>
      <p className="text-slate-400 text-xs font-black uppercase tracking-widest border-l-4 border-indigo-600 pl-4">{subtitle}</p>
    </div>
  );
}

function DatabaseUploader({ onDataLoaded, currentDataLength }: { onDataLoaded: (data: any[], name: string) => void, currentDataLength: number }) {
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const preProcessData = (raw: any[]) => {
    if (raw.length === 0) return raw;
    const headers = Object.keys(raw[0]);
    if (headers.length === 0) return raw;
    const keyHeader = headers[0];

    let lastKey = "";
    return raw.map(row => {
      const val = row[keyHeader];
      if (val && String(val).trim()) {
        lastKey = String(val).trim();
      }
      return { ...row, [keyHeader]: lastKey };
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const bstr = evt.target?.result;
      const wb = XLSX.read(bstr, { type: 'binary' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { defval: "" }); 
      const processed = preProcessData(raw);
      onDataLoaded(processed, f.name);
    };
    reader.readAsBinaryString(f);
  };

  const handlePaste = () => {
    const lines = pasteValue.trim().split('\n');
    if (lines.length < 2) return;
    const headers = lines[0].split(/\t|,/);
    const raw = lines.slice(1).map(line => {
      const values = line.split(/\t|,/);
      const obj: any = {};
      headers.forEach((h, i) => { obj[h.trim()] = values[i]?.trim(); });
      return obj;
    });
    const processed = preProcessData(raw);
    onDataLoaded(processed, "Manual Ingestion");
    setPasteMode(false);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
      <div 
        onClick={() => fileRef.current?.click()}
        className="group relative h-80 border-4 border-slate-50 rounded-[40px] bg-[#FDFDFF] p-10 flex flex-col items-center justify-center cursor-pointer hover:border-indigo-400 hover:bg-white transition-all shadow-sm"
      >
        <input ref={fileRef} type="file" className="hidden" accept=".xlsx,.xls,.csv" onChange={handleFileUpload} />
        <div className="w-20 h-20 bg-indigo-50 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-indigo-600 group-hover:text-white transition-all shadow-inner">
          <TableIcon className="w-10 h-10" />
        </div>
        <h3 className="text-2xl font-black text-slate-800 tracking-tight uppercase italic">Catalog Upload</h3>
        <p className="text-[10px] text-slate-400 mt-4 font-black uppercase tracking-[0.3em]">XLSX / CSV FORMATS</p>
      </div>

      <div className="border-4 border-slate-50 rounded-[40px] bg-[#FDFDFF] p-10 flex flex-col transition-all hover:border-indigo-100">
        <div className="flex items-center justify-between mb-8">
          <h3 className="font-black text-2xl italic tracking-tight flex items-center space-x-3">
            <ClipboardList className="w-7 h-7 text-indigo-600" />
            <span className="uppercase">Direct Input</span>
          </h3>
          {pasteMode && (
            <button onClick={() => setPasteMode(false)} className="text-[10px] text-red-500 font-black uppercase underline tracking-widest">Abort</button>
          )}
        </div>
        
        {pasteMode ? (
          <div className="flex-1 space-y-4">
            <textarea 
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              placeholder="Paste rows from spreadsheet..."
              className="w-full h-40 bg-white border border-slate-200 rounded-[32px] p-6 text-xs font-mono focus:ring-8 focus:ring-indigo-50/50 outline-none resize-none shadow-inner"
            />
            <button 
              onClick={handlePaste}
              className="w-full bg-slate-900 text-white py-5 rounded-2xl text-[10px] font-black uppercase tracking-[0.3em] shadow-2xl transition-all active:scale-95"
            >
              Parse Data Nodes
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center border-4 border-dashed border-slate-100 rounded-[32px] p-8 group transition-all hover:bg-white cursor-pointer" onClick={() => setPasteMode(true)}>
            <div className="text-indigo-600 font-black text-[10px] uppercase tracking-[0.4em] mb-4">Click to Open Buffer</div>
            <div className="w-12 h-1 bg-indigo-100 rounded-full group-hover:w-24 transition-all"></div>
          </div>
        )}
      </div>
    </div>
  );
}
