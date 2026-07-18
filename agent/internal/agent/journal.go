package agent

import (
	"encoding/json"
	"os"
	"sort"
	"sync"
	"time"
)

// ponytail (BUG-05): task journal records the outcome of every task the
// agent executes. Purpose: absorb redeliveries. When the network drops
// between "action side-effect ran" and "server got the result", the reaper
// will requeue the same task ID and eventually re-dispatch it under a new
// nonce. Without the journal the second dispatch would re-execute the side
// effect (double backup, double config write, double upgrade). With the
// journal, the second dispatch returns the cached result immediately —
// still under the new nonce, so the server's CAS accepts it and drives the
// batch state machine forward.
//
// Storage: JSON blob at ~/.ai-console-agent/task-journal.json, 0600.
// Bounded to journalMaxEntries (1000) or journalTTL (30 days), whichever
// evicts first. Writes are atomic (writeFileAtomic same as configs).

const (
	journalMaxEntries = 1000
	journalTTL        = 30 * 24 * time.Hour
)

type journalEntry struct {
	Action     string                 `json:"action"`
	Ok         bool                   `json:"ok"`
	Result     map[string]interface{} `json:"result"`
	Error      string                 `json:"error"`
	FinishedAt int64                  `json:"finished_at"`
}

type taskJournal struct {
	path    string
	mu      sync.Mutex
	entries map[string]*journalEntry
}

func openTaskJournal(path string) (*taskJournal, error) {
	j := &taskJournal{path: path, entries: map[string]*journalEntry{}}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return j, nil
		}
		return j, err
	}
	var loaded map[string]*journalEntry
	if err := json.Unmarshal(data, &loaded); err != nil {
		return j, err
	}
	cutoff := time.Now().Add(-journalTTL).UnixMilli()
	for k, v := range loaded {
		if v == nil {
			continue
		}
		if v.FinishedAt < cutoff {
			continue
		}
		j.entries[k] = v
	}
	return j, nil
}

func (j *taskJournal) get(id string) (*journalEntry, bool) {
	if j == nil {
		return nil, false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	e, ok := j.entries[id]
	if !ok {
		return nil, false
	}
	// return a shallow copy so callers can't mutate the map
	cp := *e
	return &cp, true
}

func (j *taskJournal) put(id, action string, ok bool, result map[string]interface{}, errStr string) {
	if j == nil {
		return
	}
	j.mu.Lock()
	// evict expired + trim to journalMaxEntries by finished_at ascending.
	cutoff := time.Now().Add(-journalTTL).UnixMilli()
	for k, e := range j.entries {
		if e == nil || e.FinishedAt < cutoff {
			delete(j.entries, k)
		}
	}
	j.entries[id] = &journalEntry{
		Action:     action,
		Ok:         ok,
		Result:     result,
		Error:      errStr,
		FinishedAt: time.Now().UnixMilli(),
	}
	if len(j.entries) > journalMaxEntries {
		// oldest by finished_at wins eviction
		type kv struct {
			k  string
			at int64
		}
		list := make([]kv, 0, len(j.entries))
		for k, v := range j.entries {
			list = append(list, kv{k, v.FinishedAt})
		}
		sort.Slice(list, func(i, jj int) bool { return list[i].at < list[jj].at })
		drop := len(j.entries) - journalMaxEntries
		for i := 0; i < drop; i++ {
			delete(j.entries, list[i].k)
		}
	}
	// clone before releasing the lock so persist doesn't hold the mutex
	// across the disk write.
	snapshot := make(map[string]*journalEntry, len(j.entries))
	for k, v := range j.entries {
		snapshot[k] = v
	}
	j.mu.Unlock()

	// ponytail (BUG-05): atomic write. If the process dies mid-write the
	// tempfile is left behind and the next boot's openTaskJournal parses the
	// old file; either way the journal never sees a torn JSON.
	data, err := json.Marshal(snapshot)
	if err != nil {
		return
	}
	_ = writeFileAtomic(j.path, data, 0600)
}

// journalGet / journalPut are thin wrappers on the Agent so callers don't need
// to nil-check the journal handle every time.
func (a *Agent) journalGet(id string) (*journalEntry, bool) {
	return a.journal.get(id)
}

func (a *Agent) journalPut(id, action string, ok bool, result map[string]interface{}, errStr string) {
	a.journal.put(id, action, ok, result, errStr)
}
