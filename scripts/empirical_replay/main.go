package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	initMem   = 100
	simEpochs = 60
	epochMult = 5
	qPerEpoch = 15
	qSize     = 3
	servePer  = 3
	badRate   = 0.12
	tpDeny    = 0.55
	fpDeny    = 0.04
	maxKw     = 7
	embedDim  = 768

	defaultReplayWatchdogSeconds   = 1800
	defaultSeedCommitTimeoutSecs   = 300
	defaultEpochAdvanceTimeoutSecs = 20
	defaultLifecycleTimeoutSecs    = 300
	defaultBatchIntervalSecs       = 5
)

var fixtureVocabulary = []string{
	"redis", "postgres", "qdrant", "nginx", "docker", "kubernetes",
	"cosmos", "cometbft", "grpc", "rest", "websocket", "tcp",
	"authentication", "authorization", "encryption", "umbral",
	"ed25519", "secp256k1", "x25519", "aes",
	"javascript", "typescript", "go", "rust", "python",
	"memory", "moderation", "approval", "denial", "retrieval",
	"embedding", "vector", "keyword", "ranking", "scoring",
	"epoch", "rotation", "lifecycle", "archive", "decay",
	"throughput", "latency", "concurrency", "deadlock", "race",
	"config", "deployment", "monitoring", "logging", "tracing",
}

type identity struct {
	EdPubHex  string
	EdPriv    ed25519.PrivateKey
	XPubHex   string
	XPrivHex  string
	WalletRef string
}

type memoryMeta struct {
	Hash           string
	IsGood         bool
	Keywords       []string
	KeywordWeights []float64
	Archived       bool
}

type fixtureMemory struct {
	cid            string
	isGood         bool
	plaintext      string
	keywords       []string
	keywordWeights []float64
	createdEpoch   uint64
}

type harness struct {
	hubURL     string
	chainRPC   string
	seed       int64
	rng        *rand.Rand
	httpClient *http.Client

	maxRuntime          time.Duration
	runDeadline         time.Time
	seedCommitTimeout   time.Duration
	epochAdvanceTimeout time.Duration
	lifecycleTimeout    time.Duration
	batchInterval       time.Duration

	leader      identity
	moderator   identity
	contributor identity
	consumer    identity

	orgID string

	keywordSet map[string]struct{}
	memories   []memoryMeta
	zeroVector []float64

	// firstServedCID is the first memory CID recorded as served during epoch 1.
	// Used by sanityCheckServesReachChain to verify the hub→chain batcher is
	// flushing serve events to the chain. Zero value (empty string) means no
	// serve has been recorded yet.
	firstServedCID string
}

func main() {
	seed := int64(envIntOrDefault("REPLAY_SEED", 42))

	h := newHarness(seed)
	if err := h.run(); err != nil {
		fmt.Fprintf(os.Stderr, "empirical replay failed: %v\n", err)
		os.Exit(1)
	}
}

func newHarness(seed int64) *harness {
	hubURL := strings.TrimRight(getenv("HUB_URL", "http://localhost:4440"), "/")
	chainRPC := strings.TrimRight(getenv("CHAIN_RPC", "http://localhost:26657"), "/")
	orgID := strings.TrimSpace(getenv("ORG_ID", "empirical-replay-org"))

	orgDigest := sha256.Sum256([]byte(orgID))
	orgSeedMix := int64(binary.BigEndian.Uint64(orgDigest[:8]))
	r := rand.New(rand.NewSource(seed ^ orgSeedMix))

	h := &harness{
		hubURL:     hubURL,
		chainRPC:   chainRPC,
		seed:       seed,
		rng:        r,
		httpClient: &http.Client{Timeout: 20 * time.Second},
		keywordSet: make(map[string]struct{}),
		zeroVector: make([]float64, embedDim),
		maxRuntime: time.Duration(envPositiveIntOrDefault("REPLAY_MAX_DURATION_SECONDS", defaultReplayWatchdogSeconds)) * time.Second,
		seedCommitTimeout: time.Duration(
			envPositiveIntOrDefault("REPLAY_SEED_COMMIT_TIMEOUT_SECONDS", defaultSeedCommitTimeoutSecs),
		) * time.Second,
		epochAdvanceTimeout: time.Duration(
			envPositiveIntOrDefault("REPLAY_EPOCH_ADVANCE_TIMEOUT_SECONDS", defaultEpochAdvanceTimeoutSecs),
		) * time.Second,
		lifecycleTimeout: time.Duration(
			envPositiveIntOrDefault("REPLAY_LIFECYCLE_TIMEOUT_SECONDS", defaultLifecycleTimeoutSecs),
		) * time.Second,
		batchInterval: time.Duration(
			envPositiveIntOrDefault("REPLAY_BATCH_INTERVAL_SECONDS", defaultBatchIntervalSecs),
		) * time.Second,
	}
	h.runDeadline = time.Now().Add(h.maxRuntime)

	h.leader = h.newIdentity()
	h.moderator = h.newIdentity()
	h.contributor = h.newIdentity()
	h.consumer = h.newIdentity()
	h.orgID = orgID

	return h
}

func (h *harness) run() error {
	if err := h.ensureWithinWatchdog("preflight"); err != nil {
		return err
	}
	if err := h.preflight(); err != nil {
		return err
	}
	if err := h.ensureWithinWatchdog("create org"); err != nil {
		return err
	}
	if err := h.createOrg(); err != nil {
		return err
	}
	if err := h.ensureWithinWatchdog("bootstrap leader wallet"); err != nil {
		return err
	}
	if err := h.bootstrapLeaderWalletForHarness(); err != nil {
		return err
	}
	if err := h.ensureWithinWatchdog("invite moderator"); err != nil {
		return err
	}
	if err := h.inviteMember(h.moderator, "moderator"); err != nil {
		return err
	}
	if err := h.ensureWithinWatchdog("invite contributor"); err != nil {
		return err
	}
	if err := h.inviteMember(h.contributor, "member"); err != nil {
		return err
	}
	if err := h.ensureWithinWatchdog("invite consumer"); err != nil {
		return err
	}
	if err := h.inviteMember(h.consumer, "member"); err != nil {
		return err
	}
	if err := h.ensureWithinWatchdog("seed memories"); err != nil {
		return err
	}
	if err := h.seedMemories(); err != nil {
		return err
	}
	goodCount := h.countGood()
	badCount := len(h.memories) - goodCount
	fmt.Printf("[seed] created %d memories (%d good, %d bad)\n", len(h.memories), goodCount, badCount)

	totalEpochs := envPositiveIntOrDefault("REPLAY_TOTAL_EPOCHS", simEpochs*epochMult)
	for e := 0; e < totalEpochs; e++ {
		if err := h.ensureWithinWatchdog(fmt.Sprintf("epoch loop %d/%d", e+1, totalEpochs)); err != nil {
			return err
		}

		epochStart := time.Now()
		currentEpoch, err := h.getChainCurrentEpoch()
		if err != nil {
			return fmt.Errorf("resolve chain epoch before epoch %d: %w", e+1, err)
		}

		if err := h.simulateEpoch(currentEpoch, e); err != nil {
			return err
		}
		if err := h.waitEpochAdvance(currentEpoch+1, h.epochAdvanceTimeout); err != nil {
			return err
		}

		fmt.Printf("[epoch %d/%d] traffic+advance took %v\n", e+1, totalEpochs, time.Since(epochStart))

		if e == 0 {
			if err := h.sanityCheckServesReachChain(); err != nil {
				return err
			}
		}
	}

	if err := h.ensureWithinWatchdog("survival measurement"); err != nil {
		return err
	}
	goodSurv, badPersist, err := h.measureSurvival()
	if err != nil {
		return err
	}
	gap := goodSurv - badPersist

	fmt.Printf("\n=== Empirical Replay Result ===\n")
	fmt.Printf("Seed:                %d\n", h.seed)
	fmt.Printf("Memories:            %d good, %d bad\n", goodCount, badCount)
	fmt.Printf("Good surviving:      %.4f\n", goodSurv)
	fmt.Printf("Bad persisting:      %.4f\n", badPersist)
	fmt.Printf("Decoupling gap:      %.4fpp\n", gap*100)
	fmt.Printf("Sprint contract:     ≥ 75pp     [%s]\n", passFail(gap*100 >= 75.0))

	return nil
}

func (h *harness) preflight() error {
	var health map[string]any
	if err := h.doJSON(http.MethodGet, h.hubURL+"/health", nil, nil, &health); err != nil {
		return fmt.Errorf("hub preflight failed at %s/health: %w", h.hubURL, err)
	}

	var chainRPCStatus map[string]any
	if err := h.doJSON(http.MethodGet, h.chainRPC+"/status", nil, nil, &chainRPCStatus); err != nil {
		return fmt.Errorf("chain preflight failed at %s/status: %w", h.chainRPC, err)
	}

	var testHealth map[string]any
	if err := h.doJSON(http.MethodGet, h.hubURL+"/v1/test/health", nil, nil, &testHealth); err != nil {
		return fmt.Errorf("test health preflight failed at %s/v1/test/health: %w", h.hubURL, err)
	}

	chainStatus, _ := testHealth["chain"].(string)
	if chainStatus != "connected" {
		return fmt.Errorf("chain not connected according to /v1/test/health: %v", testHealth)
	}

	return nil
}

func (h *harness) createOrg() error {
	encEnvelope := h.randHex(96)
	searchEnvelope := h.randHex(96)
	modEnvelope := h.randHex(96)

	feeModel := map[string]any{
		"tier":            "starter",
		"monthly_credits": 1000,
		"per_query_cost":  1,
		"currency":        "USD",
	}
	domain := fmt.Sprintf("co034-%d.wevibe.dev", time.Now().UnixNano())

	msg := createOrgCanonical(
		h.orgID,
		h.leader.EdPubHex,
		h.leader.XPubHex,
		"CO-034 Empirical Replay Org",
		domain,
		encEnvelope,
		searchEnvelope,
		modEnvelope,
		h.leader.XPubHex,
		feeModel,
	)
	sig := ed25519.Sign(h.leader.EdPriv, msg)

	body := map[string]any{
		"org_id":               h.orgID,
		"leader_pubkey":        h.leader.EdPubHex,
		"leader_x25519_pubkey": h.leader.XPubHex,
		"org_name":             "CO-034 Empirical Replay Org",
		"domain":               domain,
		"fee_model":            feeModel,
		"pk_mod":               h.leader.XPubHex,
		"enc_envelope":         encEnvelope,
		"search_envelope":      searchEnvelope,
		"mod_envelope":         modEnvelope,
		"signed_by":            h.leader.EdPubHex,
		"signature":            hex.EncodeToString(sig),
	}

	var resp map[string]any
	if err := h.doJSON(http.MethodPost, h.hubURL+"/v1/orgs", body, nil, &resp); err != nil {
		return fmt.Errorf("create org failed: %w", err)
	}
	return nil
}

func (h *harness) inviteMember(member identity, role string) error {
	encEnvelope := h.randHex(96)
	searchEnvelope := h.randHex(96)

	modEnvelope := ""
	if role == "leader" || role == "moderator" {
		modEnvelope = h.randHex(96)
	}

	msg := inviteMemberCanonical(h.orgID, member.EdPubHex, member.XPubHex, role, h.leader.EdPubHex, encEnvelope, searchEnvelope, modEnvelope)
	sig := ed25519.Sign(h.leader.EdPriv, msg)

	body := map[string]any{
		"pubkey":          member.EdPubHex,
		"x25519_pubkey":   member.XPubHex,
		"role":            role,
		"enc_envelope":    encEnvelope,
		"search_envelope": searchEnvelope,
		"mod_envelope":    modEnvelope,
		"signed_by":       h.leader.EdPubHex,
		"signature":       hex.EncodeToString(sig),
	}

	var resp map[string]any
	url := fmt.Sprintf("%s/v1/orgs/%s/members", h.hubURL, h.orgID)
	if err := h.doJSON(http.MethodPost, url, body, h.signedHeader(h.leader), &resp); err != nil {
		return fmt.Errorf("invite member %s failed: %w", member.EdPubHex[:10], err)
	}
	return nil
}

func (h *harness) seedMemories() error {
	if err := h.ensureWithinWatchdog("seed epoch lookup"); err != nil {
		return err
	}

	seedEpoch, err := h.getOrgCurrentEpoch()
	if err != nil {
		return fmt.Errorf("resolve seed epoch: %w", err)
	}

	if err := h.bootstrapFixtureVocabulary(); err != nil {
		return fmt.Errorf("bootstrap fixture vocabulary: %w", err)
	}

	for i := 0; i < initMem; i++ {
		if err := h.ensureWithinWatchdog(fmt.Sprintf("seed memory %d/%d", i+1, initMem)); err != nil {
			return err
		}

		fixture, err := h.generateFixtureMemory(seedEpoch, i)
		if err != nil {
			return fmt.Errorf("generate fixture memory %d: %w", i, err)
		}

		meta, err := h.seedOneMemory(i, seedEpoch, fixture)
		if err != nil {
			return err
		}
		h.memories = append(h.memories, meta)
	}

	hashes := make([]string, 0, len(h.memories))
	for _, mem := range h.memories {
		hashes = append(hashes, mem.Hash)
	}

	if err := h.waitForLifecycleState(hashes, "pending", h.lifecycleTimeout); err != nil {
		return err
	}

	for _, mem := range h.memories {
		if err := h.approveMemoryAsModerator(mem.Hash, seedEpoch, mem.IsGood); err != nil {
			return err
		}
	}

	if err := h.waitForLifecycleState(hashes, "pending_keyword", h.lifecycleTimeout); err != nil {
		return err
	}

	if err := h.runBatchKeywordExtraction(h.memories); err != nil {
		return err
	}

	if err := h.waitForLifecycleState(hashes, "pending_chain", h.lifecycleTimeout); err != nil {
		return err
	}

	if err := h.submitChainBatch(); err != nil {
		return err
	}

	if err := h.waitForLifecycleState(hashes, "committed", h.seedCommitTimeout); err != nil {
		return err
	}

	return nil
}

func (h *harness) seedOneMemory(i int, epochID int, fixture fixtureMemory) (memoryMeta, error) {
	if err := validateKeywordFixture(fixture.keywords, fixture.keywordWeights); err != nil {
		return memoryMeta{}, fmt.Errorf("invalid keyword fixture for memory %d: %w", i, err)
	}

	mType := "correct_implementation"
	if !fixture.isGood {
		mType = "negative_signal"
	}

	plaintext := fixture.plaintext
	saltHex := h.randHex(32)
	plaintextHash := sha256hex([]byte(plaintext))
	ciphertextHex := h.randHex(96)
	wrappedDekHex := h.randHex(48)
	ciphertextBytes, _ := hex.DecodeString(ciphertextHex)
	wrappedBytes, _ := hex.DecodeString(wrappedDekHex)
	ciphertextHash := sha256hex(ciphertextBytes)
	wrappedDekHash := sha256hex(wrappedBytes)

	combined := append(append([]byte{}, ciphertextBytes...), wrappedBytes...)
	submissionHash := sha256hex(combined)
	submitCanonical := submitMemoryCanonical(
		h.orgID,
		epochID,
		submissionHash,
		h.contributor.EdPubHex,
		mType,
		plaintextHash,
		saltHex,
		ciphertextHash,
		wrappedDekHash,
	)
	contributorSig := hex.EncodeToString(ed25519.Sign(h.contributor.EdPriv, submitCanonical))

	submitBody := map[string]any{
		"org_id":             h.orgID,
		"epoch_id":           epochID,
		"ciphertext":         ciphertextHex,
		"wrapped_dek_mod":    wrappedDekHex,
		"submission_hash":    submissionHash,
		"contributor_pubkey": h.contributor.EdPubHex,
		"contributor_sig":    contributorSig,
		"stack_hint":         fixture.keywords,
		"memory_type":        mType,
		"plaintext_hash":     plaintextHash,
		"salt":               saltHex,
		"ciphertext_hash":    ciphertextHash,
		"wrapped_dek_hash":   wrappedDekHash,
	}

	var submitResp map[string]any
	submitURL := fmt.Sprintf("%s/v1/orgs/%s/submit", h.hubURL, h.orgID)
	if err := h.doJSON(http.MethodPost, submitURL, submitBody, h.signedHeader(h.contributor), &submitResp); err != nil {
		return memoryMeta{}, fmt.Errorf("submit memory %d failed: %w", i, err)
	}

	return memoryMeta{
		Hash:           submissionHash,
		IsGood:         fixture.isGood,
		Keywords:       append([]string(nil), fixture.keywords...),
		KeywordWeights: append([]float64(nil), fixture.keywordWeights...),
	}, nil
}

func (h *harness) bootstrapFixtureVocabulary() error {
	for _, keyword := range fixtureVocabulary {
		if err := h.ensureKeyword(keyword); err != nil {
			return err
		}
	}

	registered, err := h.listOrgKeywords()
	if err != nil {
		return err
	}
	if len(registered) == 0 {
		fmt.Printf("[lifecycle] keyword listing returned 0 rows after registration; continuing with seeded fixture vocabulary\n")
		return nil
	}

	missing := make([]string, 0)
	for _, keyword := range fixtureVocabulary {
		if _, ok := registered[keyword]; !ok {
			missing = append(missing, keyword)
		}
	}

	if len(missing) > 0 {
		sort.Strings(missing)
		return fmt.Errorf("missing fixture keywords after registration: %s", strings.Join(missing, ", "))
	}

	return nil
}

func (h *harness) listOrgKeywords() (map[string]struct{}, error) {
	url := fmt.Sprintf("%s/v1/orgs/%s/keywords", h.hubURL, h.orgID)
	var raw json.RawMessage
	if err := h.doJSON(http.MethodGet, url, nil, h.signedHeader(h.leader), &raw); err != nil {
		return nil, fmt.Errorf("list keywords failed: %w", err)
	}

	type keywordEntry struct {
		Keyword string `json:"keyword"`
	}

	resp := make([]keywordEntry, 0)
	if err := json.Unmarshal(raw, &resp); err != nil {
		var wrapped struct {
			Keywords []keywordEntry `json:"keywords"`
		}
		if wrappedErr := json.Unmarshal(raw, &wrapped); wrappedErr != nil {
			return nil, fmt.Errorf("decode keyword list failed: %w (raw=%s)", err, string(raw))
		}
		resp = wrapped.Keywords
	}
	out := make(map[string]struct{}, len(resp))
	for _, item := range resp {
		keyword := strings.TrimSpace(strings.ToLower(item.Keyword))
		if keyword != "" {
			out[keyword] = struct{}{}
		}
	}
	return out, nil
}

func (h *harness) generateFixtureMemory(epochID int, index int) (fixtureMemory, error) {
	keywordCount := qSize + h.rng.Intn(maxKw-qSize+1)
	keywordIndexes := h.pickDistinct(keywordCount, len(fixtureVocabulary))
	keywords := make([]string, 0, len(keywordIndexes))
	for _, idx := range keywordIndexes {
		keywords = append(keywords, fixtureVocabulary[idx])
	}

	weights, err := h.generateFixtureKeywordWeights(len(keywords))
	if err != nil {
		return fixtureMemory{}, err
	}

	if err := validateKeywordFixture(keywords, weights); err != nil {
		return fixtureMemory{}, err
	}

	joinedKeywords := strings.Join(keywords, ", ")
	plaintext := fmt.Sprintf(
		"Technical insight %d about %s. In production we use %s with %s for reliable lifecycle execution.",
		index,
		joinedKeywords,
		keywords[0],
		keywords[len(keywords)-1],
	)

	return fixtureMemory{
		cid:            "",
		isGood:         h.rng.Float64() >= badRate,
		plaintext:      plaintext,
		keywords:       keywords,
		keywordWeights: weights,
		createdEpoch:   uint64(epochID),
	}, nil
}

func (h *harness) generateFixtureKeywordWeights(count int) ([]float64, error) {
	if count < 1 {
		return nil, fmt.Errorf("at least one keyword required")
	}

	raw := make([]int, count)
	rawSum := 0
	for i := 0; i < count; i++ {
		raw[i] = 5 + h.rng.Intn(96)
		rawSum += raw[i]
	}

	weightUnits := make([]int, count)
	assigned := 0
	for i := 0; i < count-1; i++ {
		units := (raw[i] * 10000) / rawSum
		if units < 1 {
			units = 1
		}
		weightUnits[i] = units
		assigned += units
	}
	weightUnits[count-1] = 10000 - assigned
	if weightUnits[count-1] < 1 {
		return nil, fmt.Errorf("unable to normalize keyword weights")
	}

	weights := make([]float64, count)
	for i, units := range weightUnits {
		weights[i] = float64(units) / 10000.0
	}

	return weights, nil
}

func (h *harness) ensureKeyword(keyword string) error {
	if _, ok := h.keywordSet[keyword]; ok {
		return nil
	}
	url := fmt.Sprintf("%s/v1/orgs/%s/keywords", h.hubURL, h.orgID)
	body := map[string]any{"keyword": keyword}
	var resp map[string]any
	if err := h.doJSON(http.MethodPost, url, body, h.signedHeader(h.leader), &resp); err != nil {
		return fmt.Errorf("add keyword %s failed: %w", keyword, err)
	}
	h.keywordSet[keyword] = struct{}{}
	return nil
}

func (h *harness) simulateEpoch(chainEpoch int, replayEpoch int) error {
	for q := 0; q < qPerEpoch; q++ {
		if err := h.ensureWithinWatchdog(fmt.Sprintf("simulate epoch %d query %d", replayEpoch+1, q+1)); err != nil {
			return err
		}

		kwIDs := h.pickDistinct(qSize, len(fixtureVocabulary))
		queryKeywords := make([]string, 0, len(kwIDs))
		for _, id := range kwIDs {
			queryKeywords = append(queryKeywords, fixtureVocabulary[id])
		}

		results, err := h.recall(queryKeywords)
		if err != nil {
			return fmt.Errorf("recall failed at replay_epoch=%d chain_epoch=%d query=%d: %w", replayEpoch, chainEpoch, q, err)
		}
		if len(results) == 0 {
			continue
		}

		limit := servePer
		if len(results) < limit {
			limit = len(results)
		}
		for i := 0; i < limit; i++ {
			if err := h.ensureWithinWatchdog(fmt.Sprintf("simulate epoch %d serve %d", replayEpoch+1, i+1)); err != nil {
				return err
			}

			r := results[i]
			if r.CID == "" {
				continue
			}
			meta, ok := h.memoryByHash(r.CID)
			if !ok {
				continue
			}

			matchedKeywords := intersectKeywords(meta.Keywords, queryKeywords)
			if len(matchedKeywords) == 0 {
				continue
			}

			if err := h.recordServe(r.CID, matchedKeywords, chainEpoch); err != nil {
				return err
			}

			pDeny := tpDeny
			if meta.IsGood {
				pDeny = fpDeny
			}
			if h.rng.Float64() < pDeny {
				if err := h.recordDenial(r.CID); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

type recallResult struct {
	CID string `json:"cid"`
}

func (h *harness) recall(queryKeywords []string) ([]recallResult, error) {
	weights := make([]map[string]any, 0, len(queryKeywords))
	for _, kw := range queryKeywords {
		weights = append(weights, map[string]any{"keyword": kw, "weight": 1.0 / float64(len(queryKeywords))})
	}

	body := map[string]any{
		"org_id":          h.orgID,
		"agent_pubkey":    h.consumer.EdPubHex,
		"pre_pubkey":      h.consumer.XPubHex,
		"keyword_weights": weights,
		"vector":          h.zeroVector,
		"limit":           servePer,
		"agent_sig":       "",
	}

	url := fmt.Sprintf("%s/v1/orgs/%s/query", h.hubURL, h.orgID)
	var resp struct {
		Results []recallResult `json:"results"`
	}
	if err := h.doJSON(http.MethodPost, url, body, h.signedHeader(h.consumer), &resp); err != nil {
		return nil, err
	}
	return resp.Results, nil
}

func (h *harness) recordServe(memoryHash string, queryKeywords []string, epoch int) error {
	body := map[string]any{
		"org_id":              h.orgID,
		"epoch_id":            epoch,
		"memory_content_hash": memoryHash,
		"serve_key":           memoryHash,
		"contributor_id":      h.contributor.EdPubHex,
		"nullifier":           h.randHex(32),
		"model_id":            "co-034-replay",
		"turn_count":          1,
		"matched_keywords":    queryKeywords,
	}

	url := fmt.Sprintf("%s/v1/orgs/%s/serves", h.hubURL, h.orgID)
	var resp map[string]any
	if err := h.doJSON(http.MethodPost, url, body, h.signedHeader(h.consumer), &resp); err != nil {
		return fmt.Errorf("record serve failed for %s: %w", memoryHash, err)
	}
	if h.firstServedCID == "" {
		h.firstServedCID = memoryHash
	}
	return nil
}

func (h *harness) recordDenial(memoryHash string) error {
	body := map[string]any{
		"memory_hash": memoryHash,
		"nullifier":   h.randHex(32),
		"reason":      "co-034-empirical-denial",
	}

	url := fmt.Sprintf("%s/v1/orgs/%s/denials", h.hubURL, h.orgID)
	var resp map[string]any
	if err := h.doJSON(http.MethodPost, url, body, h.signedHeader(h.consumer), &resp); err != nil {
		return fmt.Errorf("record denial failed for %s: %w", memoryHash, err)
	}
	return nil
}

func (h *harness) queryArchivalState() (map[string]string, error) {
	url := fmt.Sprintf("%s/v1/orgs/%s/submissions", h.hubURL, h.orgID)
	var resp struct {
		Submissions []struct {
			SubmissionHash string `json:"submission_hash"`
			Status         string `json:"status"`
		} `json:"submissions"`
	}
	if err := h.doJSON(http.MethodGet, url, nil, h.signedHeader(h.leader), &resp); err != nil {
		return nil, fmt.Errorf("query archival state failed: %w", err)
	}
	out := make(map[string]string, len(resp.Submissions))
	for _, s := range resp.Submissions {
		out[s.SubmissionHash] = s.Status
	}
	return out, nil
}

func (h *harness) measureSurvival() (float64, float64, error) {
	goodTotal := 0
	goodPresent := 0
	badTotal := 0
	badPresent := 0

	for i := range h.memories {
		if err := h.ensureWithinWatchdog(fmt.Sprintf("survival measurement %d/%d", i+1, len(h.memories))); err != nil {
			return 0, 0, err
		}

		archived, err := h.queryArchivedFromChain(h.memories[i].Hash)
		if err != nil {
			return 0, 0, fmt.Errorf("query archived state for %s: %w", h.memories[i].Hash, err)
		}
		h.memories[i].Archived = archived
		present := !archived

		m := h.memories[i]
		if m.IsGood {
			goodTotal++
			if present {
				goodPresent++
			}
		} else {
			badTotal++
			if present {
				badPresent++
			}
		}
	}

	var goodSurv, badPersist float64
	if goodTotal > 0 {
		goodSurv = float64(goodPresent) / float64(goodTotal)
	}
	if badTotal > 0 {
		badPersist = float64(badPresent) / float64(badTotal)
	}
	return goodSurv, badPersist, nil
}

func (h *harness) waitEpochAdvance(targetEpoch int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := h.ensureWithinWatchdog("epoch advance wait"); err != nil {
			return err
		}

		now, err := h.getChainCurrentEpoch()
		if err == nil && now >= targetEpoch {
			return nil
		}
		time.Sleep(400 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for chain epoch >= %d", targetEpoch)
}

func (h *harness) getChainCurrentEpoch() (int, error) {
	url := h.chainRPC + "/block_results"
	var resp struct {
		Result struct {
			Height              string `json:"height"`
			FinalizeBlockEvents []struct {
				Type       string `json:"type"`
				Attributes []struct {
					Key   string `json:"key"`
					Value string `json:"value"`
				} `json:"attributes"`
			} `json:"finalize_block_events"`
		} `json:"result"`
	}
	if err := h.doJSON(http.MethodGet, url, nil, nil, &resp); err != nil {
		return 0, fmt.Errorf("query chain block_results failed: %w", err)
	}

	currentEpoch := -1
	for _, event := range resp.Result.FinalizeBlockEvents {
		if event.Type != "cosmos.epochs.v1beta1.EventEpochStart" && event.Type != "cosmos.epochs.v1beta1.EventEpochEnd" {
			continue
		}

		for _, attr := range event.Attributes {
			if attr.Key != "epoch_number" {
				continue
			}
			raw := strings.Trim(strings.TrimSpace(attr.Value), "\"")
			epochNumber, err := strconv.Atoi(raw)
			if err != nil {
				continue
			}
			if epochNumber > currentEpoch {
				currentEpoch = epochNumber
			}
		}
	}

	if currentEpoch < 0 {
		return 0, fmt.Errorf("epoch_number not found in block_results at height %s", resp.Result.Height)
	}

	return currentEpoch, nil
}

func (h *harness) getOrgCurrentEpoch() (int, error) {
	url := fmt.Sprintf("%s/v1/members/%s/orgs", h.hubURL, h.leader.EdPubHex)
	var resp struct {
		Orgs []struct {
			OrgID        string `json:"org_id"`
			CurrentEpoch int    `json:"current_epoch"`
		} `json:"orgs"`
	}
	if err := h.doJSON(http.MethodGet, url, nil, h.signedHeader(h.leader), &resp); err != nil {
		return 0, err
	}

	for _, org := range resp.Orgs {
		if org.OrgID == h.orgID {
			return org.CurrentEpoch, nil
		}
	}

	return 0, fmt.Errorf("org %s not found in discover response", h.orgID)
}

func (h *harness) queryArchivedFromChain(cid string) (bool, error) {
	url := fmt.Sprintf("%s/v1/orgs/%s/memories/%s", h.hubURL, h.orgID, cid)
	var resp map[string]any
	err := h.doJSON(http.MethodGet, url, nil, h.signedHeader(h.leader), &resp)
	if err != nil {
		if strings.Contains(err.Error(), "HTTP 404") {
			return false, nil
		}
		return false, err
	}

	stateRaw, ok := resp["state"]
	if !ok {
		return false, fmt.Errorf("missing state in memory response")
	}

	switch state := stateRaw.(type) {
	case float64:
		return int(state) == 6, nil
	case string:
		n := strings.TrimSpace(strings.ToLower(state))
		return n == "6" || strings.Contains(n, "archived"), nil
	default:
		return false, fmt.Errorf("unexpected state type %T", stateRaw)
	}
}

// getServeCountTotalFromChain fetches the chain-recorded total serve count for
// a memory via the hub's memory-detail endpoint. Returns 0 with an error if the
// field is missing or malformed; returns 0 with nil only when the field is
// explicitly present as zero.
func (h *harness) getServeCountTotalFromChain(cid string) (uint64, error) {
	url := fmt.Sprintf("%s/v1/orgs/%s/memories/%s", h.hubURL, h.orgID, cid)
	var resp map[string]any
	if err := h.doJSON(http.MethodGet, url, nil, h.signedHeader(h.leader), &resp); err != nil {
		return 0, err
	}

	raw, ok := resp["serve_count_total"]
	if !ok {
		return 0, fmt.Errorf("serve_count_total missing from memory response for %s", cid)
	}

	switch v := raw.(type) {
	case float64:
		if v < 0 {
			return 0, fmt.Errorf("serve_count_total is negative (%v) for %s", v, cid)
		}
		return uint64(v), nil
	case string:
		n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("serve_count_total string %q is not a uint64: %w", v, err)
		}
		return n, nil
	default:
		return 0, fmt.Errorf("unexpected serve_count_total type %T for %s", raw, cid)
	}
}

// sanityCheckServesReachChain verifies that at least one serve event recorded
// against the hub during epoch 1 has propagated to the chain. The hub→chain
// batcher polls every 500ms and chain commit adds another ~2s of latency, so
// we poll for up to ~5 seconds before declaring failure. This guards against a
// silent regression where serve_events accumulate in Postgres but never reach
// the chain.
func (h *harness) sanityCheckServesReachChain() error {
	if h.firstServedCID == "" {
		return nil
	}

	const (
		attempts = 10
		interval = 500 * time.Millisecond
	)
	totalWait := time.Duration(attempts) * interval

	var (
		count   uint64
		lastErr error
	)
	for i := 0; i < attempts; i++ {
		count, lastErr = h.getServeCountTotalFromChain(h.firstServedCID)
		if lastErr == nil && count > 0 {
			fmt.Printf("[sanity] PASS: memory %s has serve_count_total=%d on chain after epoch 1\n", h.firstServedCID, count)
			return nil
		}
		if i < attempts-1 {
			time.Sleep(interval)
		}
	}

	if lastErr != nil {
		return fmt.Errorf("SANITY FAIL: memory %s was served in epoch 1 but chain query failed after %s: %w — serve events are not reaching the chain. Check hub→chain batcher.", h.firstServedCID, totalWait, lastErr)
	}
	return fmt.Errorf("SANITY FAIL: memory %s was served in epoch 1 but chain shows serve_count_total=0 after %s — serve events are not reaching the chain. Check hub→chain batcher.", h.firstServedCID, totalWait)
}

func (h *harness) doJSON(method, url string, payload any, headers map[string]string, out any) error {
	if err := h.ensureWithinWatchdog(fmt.Sprintf("%s %s", method, url)); err != nil {
		return err
	}

	var bodyReader *bytes.Reader
	if payload == nil {
		bodyReader = bytes.NewReader(nil)
	} else {
		data, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("encode request JSON: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := h.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request %s %s failed: %w", method, url, err)
	}
	defer resp.Body.Close()

	var decoded any
	if out == nil {
		out = &decoded
	}
	decoder := json.NewDecoder(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var errBody map[string]any
		if decodeErr := decoder.Decode(&errBody); decodeErr == nil {
			return fmt.Errorf("%s %s -> HTTP %d: %v", method, url, resp.StatusCode, errBody)
		}
		return fmt.Errorf("%s %s -> HTTP %d", method, url, resp.StatusCode)
	}

	if err := decoder.Decode(out); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return fmt.Errorf("decode response JSON for %s %s: %w", method, url, err)
	}
	return nil
}

func (h *harness) signedHeader(id identity) map[string]string {
	timestamp := time.Now().UTC().Format(time.RFC3339)
	sig := ed25519.Sign(id.EdPriv, []byte(timestamp))
	return map[string]string{
		"Authorization": fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", id.EdPubHex, timestamp, hex.EncodeToString(sig)),
	}
}

func (h *harness) newIdentity() identity {
	seed := make([]byte, 32)
	h.fill(seed)
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)

	xPriv := make([]byte, 32)
	xPub := make([]byte, 32)
	h.fill(xPriv)
	h.fill(xPub)

	return identity{
		EdPubHex:  hex.EncodeToString(pub),
		EdPriv:    priv,
		XPubHex:   hex.EncodeToString(xPub),
		XPrivHex:  hex.EncodeToString(xPriv),
		WalletRef: "",
	}
}

func (h *harness) fill(dst []byte) {
	for i := range dst {
		dst[i] = byte(h.rng.Intn(256))
	}
}

func (h *harness) randHex(nBytes int) string {
	b := make([]byte, nBytes)
	h.fill(b)
	return hex.EncodeToString(b)
}

func (h *harness) pickDistinct(n, max int) []int {
	if n >= max {
		out := make([]int, max)
		for i := 0; i < max; i++ {
			out[i] = i
		}
		return out
	}
	idxs := make(map[int]struct{}, n)
	for len(idxs) < n {
		idxs[h.rng.Intn(max)] = struct{}{}
	}
	out := make([]int, 0, n)
	for k := range idxs {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}

func (h *harness) memoryByHash(hash string) (memoryMeta, bool) {
	for _, m := range h.memories {
		if strings.EqualFold(m.Hash, hash) {
			return m, true
		}
	}
	return memoryMeta{}, false
}

func (h *harness) countGood() int {
	count := 0
	for _, m := range h.memories {
		if m.IsGood {
			count++
		}
	}
	return count
}

func intersectKeywords(memoryKeywords, queryKeywords []string) []string {
	if len(memoryKeywords) == 0 || len(queryKeywords) == 0 {
		return nil
	}
	memSet := make(map[string]struct{}, len(memoryKeywords))
	for _, keyword := range memoryKeywords {
		k := strings.TrimSpace(strings.ToLower(keyword))
		if k != "" {
			memSet[k] = struct{}{}
		}
	}
	out := make([]string, 0, len(queryKeywords))
	for _, keyword := range queryKeywords {
		k := strings.TrimSpace(strings.ToLower(keyword))
		if k == "" {
			continue
		}
		if _, ok := memSet[k]; ok {
			out = append(out, k)
		}
	}
	return out
}

func createOrgCanonical(orgID, leaderPubkey, leaderXPub, orgName, domain, encEnvelope, searchEnvelope, modEnvelope, pkMod string, feeModel map[string]any) []byte {
	fmHash := feeModelHash(feeModel)
	msg := strings.Join([]string{
		"wevibe.create_org.v1",
		"domain:" + domain,
		"enc_envelope:" + encEnvelope,
		"fee_model_hash:" + fmHash,
		"leader_pubkey:" + leaderPubkey,
		"leader_x25519_pubkey:" + leaderXPub,
		"mod_envelope:" + modEnvelope,
		"org_id:" + orgID,
		"org_name:" + orgName,
		"pk_mod:" + pkMod,
		"search_envelope:" + searchEnvelope,
	}, "\n")
	return []byte(msg)
}

func inviteMemberCanonical(orgID, pubkey, xPub, role, signedBy, encEnvelope, searchEnvelope, modEnvelope string) []byte {
	msg := strings.Join([]string{
		"wevibe.invite_member.v1",
		"enc_envelope:" + encEnvelope,
		"mod_envelope:" + modEnvelope,
		"org_id:" + orgID,
		"pubkey:" + pubkey,
		"role:" + role,
		"search_envelope:" + searchEnvelope,
		"signed_by:" + signedBy,
		"x25519_pubkey:" + xPub,
	}, "\n")
	return []byte(msg)
}

func approveSubmissionCanonical(orgID, submissionHash string, epochID int, memoryType, signedBy string) []byte {
	msg := strings.Join([]string{
		"wevibe.approve_submission.v2",
		"epoch_id:" + strconv.Itoa(epochID),
		"memory_type:" + memoryType,
		"org_id:" + orgID,
		"signed_by:" + signedBy,
		"submission_hash:" + submissionHash,
	}, "\n")
	return []byte(msg)
}

func submitMemoryCanonical(orgID string, epochID int, submissionHash, contributorPubkey, memoryType, plaintextHash, salt, ciphertextHash, wrappedDekHash string) []byte {
	msg := strings.Join([]string{
		"wevibe.submit_memory.v1",
		"ciphertext_hash:" + ciphertextHash,
		"contributor_pubkey:" + contributorPubkey,
		"epoch_id:" + strconv.Itoa(epochID),
		"memory_type:" + memoryType,
		"org_id:" + orgID,
		"plaintext_hash:" + plaintextHash,
		"salt:" + salt,
		"submission_hash:" + submissionHash,
		"wrapped_dek_hash:" + wrappedDekHash,
	}, "\n")
	return []byte(msg)
}

func feeModelHash(feeModel map[string]any) string {
	parts := make([]string, 0, 5)
	if v, ok := feeModel["tier"].(string); ok && v != "" {
		parts = append(parts, fmt.Sprintf("\"tier\":\"%s\"", v))
	}
	if v, ok := feeModel["monthly_credits"].(int); ok && v != 0 {
		parts = append(parts, fmt.Sprintf("\"monthly_credits\":%d", v))
	}
	if v, ok := feeModel["per_query_cost"].(int); ok && v != 0 {
		parts = append(parts, fmt.Sprintf("\"per_query_cost\":%d", v))
	}
	if v, ok := feeModel["overage_multiplier"].(float64); ok && v != 0 {
		parts = append(parts, fmt.Sprintf("\"overage_multiplier\":%v", v))
	}
	if v, ok := feeModel["currency"].(string); ok && v != "" {
		parts = append(parts, fmt.Sprintf("\"currency\":\"%s\"", v))
	}
	canonical := "{" + strings.Join(parts, ",") + "}"
	return sha256hex([]byte(canonical))
}

func sha256hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func passFail(ok bool) string {
	if ok {
		return "PASS"
	}
	return "FAIL"
}

func (h *harness) ensureWithinWatchdog(stage string) error {
	if time.Now().Before(h.runDeadline) {
		return nil
	}
	return fmt.Errorf(
		"watchdog timeout after %s (%ds) during %s",
		h.maxRuntime,
		int(h.maxRuntime.Seconds()),
		stage,
	)
}

func envIntOrDefault(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return parsed
}

func envPositiveIntOrDefault(name string, fallback int) int {
	parsed := envIntOrDefault(name, fallback)
	if parsed < 1 {
		return fallback
	}
	return parsed
}

func getenv(name, fallback string) string {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	return v
}
