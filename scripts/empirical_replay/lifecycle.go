package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

var fixtureKeywordFormatRegex = regexp.MustCompile(`^[a-z][a-z0-9_]{1,39}$`)

func (h *harness) approveMemoryAsModerator(submissionHash string, epochID int, isGood bool) error {
	memoryType := "correct_implementation"
	if !isGood {
		memoryType = "negative_signal"
	}

	approveCanonical := approveSubmissionCanonical(h.orgID, submissionHash, epochID, memoryType, h.moderator.EdPubHex)
	moderatorSig := hex.EncodeToString(ed25519.Sign(h.moderator.EdPriv, approveCanonical))
	approveURL := fmt.Sprintf("%s/v1/orgs/%s/moderation/%s/approve", h.hubURL, h.orgID, submissionHash)
	approveBody := map[string]any{
		"epoch_id":      epochID,
		"memory_type":   memoryType,
		"moderator_sig": moderatorSig,
		"signed_by":     h.moderator.EdPubHex,
	}

	var approveResp map[string]any
	if err := h.doJSON(http.MethodPost, approveURL, approveBody, h.signedHeader(h.moderator), &approveResp); err != nil {
		return fmt.Errorf("approve memory %s failed: %w", submissionHash, err)
	}

	return nil
}

func (h *harness) runBatchKeywordExtraction(memories []memoryMeta) error {
	if len(memories) == 0 {
		return nil
	}
	verifyURL := fmt.Sprintf("%s/v1/orgs/%s/verify-keywords", h.hubURL, h.orgID)
	for index, mem := range memories {
		if err := validateKeywordFixture(mem.Keywords, mem.KeywordWeights); err != nil {
			return fmt.Errorf("invalid fixture for %s: %w", mem.Hash, err)
		}

		classified := make([]map[string]any, 0, len(mem.Keywords))
		for i := range mem.Keywords {
			classified = append(classified, map[string]any{
				"keyword": mem.Keywords[i],
				"weight":  mem.KeywordWeights[i],
			})
		}

		verifyBody := map[string]any{"memories": []map[string]any{
			{
				"submission_hash": mem.Hash,
				"classified":      classified,
				"suggestions":     []any{},
			},
		}}

		var verifyResp struct {
			Verified int `json:"verified"`
			Results  []struct {
				SubmissionHash string `json:"submission_hash"`
				Error          string `json:"error"`
			} `json:"results"`
		}
		if err := h.doJSON(http.MethodPost, verifyURL, verifyBody, h.signedHeader(h.leader), &verifyResp); err != nil {
			return fmt.Errorf("verify keywords failed for %s: %w", mem.Hash, err)
		}

		errorsByHash := make([]string, 0)
		for _, result := range verifyResp.Results {
			if strings.TrimSpace(result.Error) != "" {
				errorsByHash = append(errorsByHash, fmt.Sprintf("%s: %s", result.SubmissionHash, result.Error))
			}
		}
		if len(errorsByHash) > 0 {
			sort.Strings(errorsByHash)
			return fmt.Errorf("verify keywords returned errors: %s", strings.Join(errorsByHash, "; "))
		}

		if verifyResp.Verified < 1 {
			return fmt.Errorf("verify keywords processed 0 records for %s", mem.Hash)
		}

		if (index+1)%20 == 0 || index+1 == len(memories) {
			fmt.Printf("[lifecycle] keyword verification %d/%d complete\n", index+1, len(memories))
		}
	}

	return nil
}

func (h *harness) submitChainBatch() error {
	url := fmt.Sprintf("%s/v1/orgs/%s/moderation/batch-submit", h.hubURL, h.orgID)
	var resp struct {
		Submitted int `json:"submitted"`
		Failed    int `json:"failed"`
		Results   []struct {
			SubmissionHash string `json:"submission_hash"`
			Error          string `json:"error"`
		} `json:"results"`
	}
	if err := h.doJSON(http.MethodPost, url, map[string]any{}, h.signedHeader(h.leader), &resp); err != nil {
		return fmt.Errorf("batch submit failed: %w", err)
	}

	if resp.Failed > 0 {
		errorsByHash := make([]string, 0, len(resp.Results))
		for _, result := range resp.Results {
			if strings.TrimSpace(result.Error) != "" {
				errorsByHash = append(errorsByHash, fmt.Sprintf("%s: %s", result.SubmissionHash, result.Error))
			}
		}
		sort.Strings(errorsByHash)
		return fmt.Errorf("batch submit reported %d failures: %s", resp.Failed, strings.Join(errorsByHash, "; "))
	}

	if resp.Submitted < 1 {
		return fmt.Errorf("batch submit returned submitted=%d", resp.Submitted)
	}

	return nil
}

func (h *harness) waitForLifecycleState(submissionHashes []string, targetState string, timeout time.Duration) error {
	if len(submissionHashes) == 0 {
		return nil
	}

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := h.ensureWithinWatchdog("lifecycle wait " + targetState); err != nil {
			return err
		}

		state, err := h.queryArchivalState()
		if err != nil {
			return err
		}

		allMatched := true
		stateCounts := make(map[string]int)
		for _, hash := range submissionHashes {
			status := strings.TrimSpace(state[hash])
			if status == "" {
				status = "missing"
			}
			stateCounts[status]++
			if status != targetState {
				allMatched = false
			}
		}

		if allMatched {
			return nil
		}

		time.Sleep(h.batchInterval)
	}

	state, err := h.queryArchivalState()
	if err != nil {
		return fmt.Errorf("timeout waiting for %s and failed to list submissions: %w", targetState, err)
	}

	stateCounts := make(map[string]int)
	for _, hash := range submissionHashes {
		status := strings.TrimSpace(state[hash])
		if status == "" {
			status = "missing"
		}
		stateCounts[status]++
	}

	return fmt.Errorf("timeout waiting for lifecycle state %q: statuses=%v", targetState, stateCounts)
}

func (h *harness) bootstrapLeaderWalletForHarness() error {
	hash := sha256.Sum256([]byte(h.orgID + ":" + h.leader.EdPubHex))
	walletAddress := "wevibe1" + hex.EncodeToString(hash[:20])

	msg := fmt.Sprintf("link_wallet|%s|%s|%s", h.orgID, walletAddress, h.leader.EdPubHex)
	sig := hex.EncodeToString(ed25519.Sign(h.leader.EdPriv, []byte(msg)))
	body := map[string]any{
		"wallet_address": walletAddress,
		"signed_by":      h.leader.EdPubHex,
		"signature":      sig,
	}

	var resp map[string]any
	url := fmt.Sprintf("%s/v1/orgs/%s/members/wallet", h.hubURL, h.orgID)
	if err := h.doJSON(http.MethodPost, url, body, h.signedHeader(h.leader), &resp); err != nil {
		return fmt.Errorf("bootstrap leader wallet failed: %w", err)
	}

	h.leader.WalletRef = walletAddress
	return nil
}

func validateKeywordFixture(kws []string, weights []float64) error {
	if len(kws) != len(weights) {
		return fmt.Errorf("keyword/weight length mismatch")
	}
	if len(kws) < 1 {
		return fmt.Errorf("at least one keyword required")
	}

	seen := make(map[string]struct{}, len(kws))
	sum := 0.0
	for i, keyword := range kws {
		normalized := strings.TrimSpace(strings.ToLower(keyword))
		if !fixtureKeywordFormatRegex.MatchString(normalized) {
			return fmt.Errorf("invalid keyword format: %s", keyword)
		}
		if _, ok := seen[normalized]; ok {
			return fmt.Errorf("duplicate keyword: %s", normalized)
		}
		seen[normalized] = struct{}{}

		if weights[i] <= 0 {
			return fmt.Errorf("keyword weight must be > 0 for %s", normalized)
		}
		sum += weights[i]
	}

	if math.Abs(sum-1.0) > 0.02 {
		return fmt.Errorf("weights sum to %.4f, must be 1.0 ± 0.02", sum)
	}

	return nil
}
