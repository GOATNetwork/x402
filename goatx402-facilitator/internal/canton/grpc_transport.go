package canton

// grpc_transport.go implements canton.Transport against a real Daml 2.x
// participant using google.golang.org/grpc and the Go bindings generated
// from the Daml LAPI v1 proto files (see internal/canton/lapi/).
//
// PLAN.md §6.2 transport table:
//
//   - Submit                       → CommandSubmissionService.Submit
//   - OpenCompletionStream         → CommandCompletionService.CompletionStream
//   - GetTransactionByID           → TransactionService.GetTransactionTreeById
//                                    (we want events, not the flat form, so
//                                    PaymentRequest create + Pay exercise are
//                                    both observable on the receipt path).
//   - Health                       → grpc.ClientConn.GetState() / Connect()
//                                    (Canton 2.x's gRPC LAPI does not expose
//                                    the JSON /v1/healthz from this binary;
//                                    the README accepts a connection-state
//                                    probe in localnet).
//   - AllocateParty                → admin.PartyManagementService.AllocateParty
//   - ReadMaxDeduplicationDuration → LedgerConfigurationService
//                                    .GetLedgerConfiguration (server stream;
//                                    we read the first message and close).
//
// All connections are plaintext in v0 localnet (Canton sandbox runs without
// TLS). When cfg.CantonProd is set, the dialer uses TLS. JWT auth is not
// wired in v0 — Canton localnet runs with auth disabled, and CANTON_PROD
// adds the JWT path through the gRPC `authorization` metadata in a follow-up.

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	lapiv1 "github.com/goatnetwork/goatx402-facilitator/internal/canton/lapi/gen/daml/ledger/api/v1"
	lapiadmin "github.com/goatnetwork/goatx402-facilitator/internal/canton/lapi/gen/daml/ledger/api/v1/admin"
)

// grpcTransport is the production gRPC-backed Transport. One per Client.
type grpcTransport struct {
	cfg      Config
	conn     *grpc.ClientConn
	submit   lapiv1.CommandSubmissionServiceClient
	complete lapiv1.CommandCompletionServiceClient
	tx       lapiv1.TransactionServiceClient
	cfgSvc   lapiv1.LedgerConfigurationServiceClient
	party    lapiadmin.PartyManagementServiceClient
}

// NewGRPCTransport dials the participant's Ledger API at cfg.GRPCAddr and
// returns a Transport that drives every gRPC call the canton.Client needs.
//
// Localnet (cfg.CantonProd == false): plaintext gRPC.
// Production  (cfg.CantonProd == true): mTLS using the system trust store.
//
// The dial is non-blocking; failures surface on the first RPC. Callers wrap
// in NewClient which probes ReadMaxDeduplicationDuration during boot, so a
// dead participant fails fast.
func NewGRPCTransport(cfg Config) (Transport, error) {
	if cfg.GRPCAddr == "" {
		return nil, fmt.Errorf("%w: GRPCAddr is empty", ErrInvalidConfig)
	}
	dialOpts := []grpc.DialOption{
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                durationOr(cfg.GRPCKeepaliveTime, 30*time.Second),
			Timeout:             durationOr(cfg.GRPCKeepaliveTimeout, 10*time.Second),
			PermitWithoutStream: true,
		}),
		// 64 MiB caps line up with Canton's default LAPI message-size cap so a
		// large transaction tree doesn't get truncated mid-receipt.
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(64*1024*1024),
			grpc.MaxCallSendMsgSize(64*1024*1024),
		),
	}
	if cfg.CantonProd {
		dialOpts = append(dialOpts, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
			MinVersion: tls.VersionTLS12,
		})))
	} else {
		dialOpts = append(dialOpts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	}

	conn, err := grpc.NewClient(cfg.GRPCAddr, dialOpts...)
	if err != nil {
		return nil, fmt.Errorf("canton: dial %s: %w", cfg.GRPCAddr, err)
	}
	return &grpcTransport{
		cfg:      cfg,
		conn:     conn,
		submit:   lapiv1.NewCommandSubmissionServiceClient(conn),
		complete: lapiv1.NewCommandCompletionServiceClient(conn),
		tx:       lapiv1.NewTransactionServiceClient(conn),
		cfgSvc:   lapiv1.NewLedgerConfigurationServiceClient(conn),
		party:    lapiadmin.NewPartyManagementServiceClient(conn),
	}, nil
}

// Submit translates the package's SubmitRequest into the Daml v1 Commands
// proto and forwards it via CommandSubmissionService.Submit. The call is
// non-waiting; success means the participant accepted the command. The
// eventual ledger commit (or rejection) arrives via OpenCompletionStream.
func (g *grpcTransport) Submit(ctx context.Context, req *SubmitRequest) error {
	if req == nil {
		return fmt.Errorf("canton: Submit: req is nil")
	}
	if len(req.Commands) == 0 {
		return fmt.Errorf("canton: Submit: no commands")
	}

	pbCmds := make([]*lapiv1.Command, 0, len(req.Commands))
	for _, c := range req.Commands {
		pb, err := buildCommand(c)
		if err != nil {
			return fmt.Errorf("canton: Submit: build command: %w", err)
		}
		pbCmds = append(pbCmds, pb)
	}

	commands := &lapiv1.Commands{
		LedgerId:      g.cfg.LedgerID,
		WorkflowId:    req.WorkflowID,
		ApplicationId: req.ApplicationID,
		CommandId:     req.CommandID,
		ActAs:         req.ActAs,
		ReadAs:        req.ReadAs,
		Commands:      pbCmds,
		SubmissionId:  req.SubmissionID,
		DeduplicationPeriod: &lapiv1.Commands_DeduplicationDuration{
			DeduplicationDuration: durationpb.New(req.DeduplicationDuration),
		},
	}
	_, err := g.submit.Submit(ctx, &lapiv1.SubmitRequest{Commands: commands})
	if err != nil {
		return classifyGRPC(err)
	}
	return nil
}

// OpenCompletionStream subscribes to CommandCompletionService.CompletionStream
// and bridges proto Completion messages onto our internal CompletionEvent
// channel. The returned channel is closed when the upstream stream ends or
// the context is cancelled; the Manager loop reconnects after this.
func (g *grpcTransport) OpenCompletionStream(ctx context.Context, party string, fromOffset string) (<-chan CompletionEvent, error) {
	if party == "" {
		return nil, fmt.Errorf("canton: OpenCompletionStream: party required")
	}
	req := &lapiv1.CompletionStreamRequest{
		LedgerId:      g.cfg.LedgerID,
		ApplicationId: ApplicationID,
		Parties:       []string{party},
	}
	if fromOffset != "" {
		req.Offset = &lapiv1.LedgerOffset{
			Value: &lapiv1.LedgerOffset_Absolute{Absolute: fromOffset},
		}
	}
	stream, err := g.complete.CompletionStream(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("canton: open completion stream: %w", classifyGRPC(err))
	}
	out := make(chan CompletionEvent, 16)
	go func() {
		defer close(out)
		for {
			resp, err := stream.Recv()
			if err != nil {
				return
			}
			offset := ""
			if cp := resp.GetCheckpoint(); cp != nil {
				if off := cp.GetOffset(); off != nil {
					if abs, ok := off.GetValue().(*lapiv1.LedgerOffset_Absolute); ok {
						offset = abs.Absolute
					}
				}
			}
			for _, c := range resp.GetCompletions() {
				ev := completionToEvent(c, offset)
				select {
				case out <- ev:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, nil
}

// GetTransactionByID retrieves the full transaction tree for txID. The tree
// form (as opposed to the flat form) is required so the receipt builder can
// see both the PaymentRequest create event and the Pay choice exercise event
// in one hop.
func (g *grpcTransport) GetTransactionByID(ctx context.Context, txID string) (TransactionDetails, error) {
	if txID == "" {
		return TransactionDetails{}, fmt.Errorf("canton: GetTransactionByID: txID required")
	}
	// Canton's TransactionService is party-scoped: we only see the tx if our
	// requesting_parties intersect with the transaction's stakeholders.
	// In v0 / localnet the facilitator party isn't a stakeholder on
	// PaymentRequest (signatory=payer, observer=merchant) or on the new
	// Holding (signatory=issuer, observer=merchant), so a query as the
	// facilitator party alone returns NOT_FOUND. We list all locally-known
	// parties and pass them all — the participant intersects internally.
	// This is acceptable for v0; multi-participant production would scope
	// the lookup to the order's known stakeholders (PLAN.md §6.2 — wired
	// here as a TODO when authority topology stops being flat).
	listResp, lerr := g.party.ListKnownParties(ctx, &lapiadmin.ListKnownPartiesRequest{})
	if lerr != nil {
		return TransactionDetails{}, fmt.Errorf("canton: GetTransactionByID list-parties: %w", classifyGRPC(lerr))
	}
	requesting := make([]string, 0, len(listResp.GetPartyDetails()))
	for _, pd := range listResp.GetPartyDetails() {
		if pd.GetIsLocal() && pd.GetParty() != "" {
			requesting = append(requesting, pd.GetParty())
		}
	}
	if len(requesting) == 0 {
		// Fall back to the configured operator party so the error path is
		// "the facilitator can't see it" rather than "the call is malformed".
		if g.cfg.FacilitatorActAs == "" {
			return TransactionDetails{}, fmt.Errorf("canton: GetTransactionByID: no local parties known")
		}
		requesting = []string{g.cfg.FacilitatorActAs}
	}
	resp, err := g.tx.GetTransactionById(ctx, &lapiv1.GetTransactionByIdRequest{
		LedgerId:          g.cfg.LedgerID,
		TransactionId:     txID,
		RequestingParties: requesting,
	})
	if err != nil {
		return TransactionDetails{}, fmt.Errorf("canton: GetTransactionByID(%s): %w", txID, classifyGRPC(err))
	}
	tree := resp.GetTransaction()
	if tree == nil {
		return TransactionDetails{}, fmt.Errorf("canton: GetTransactionByID(%s): empty tree", txID)
	}
	return treeToDetails(tree, g.cfg.LedgerID), nil
}

// Health probes the connection by forcing a state transition. Canton
// localnet doesn't expose a separate health endpoint on the gRPC LAPI, so
// the connection state is the next-best signal — when the dial works and
// the participant is responsive, this returns nil.
func (g *grpcTransport) Health(ctx context.Context) error {
	// Forcing a Connect() and a quick GetLedgerConfiguration round-trip is a
	// reliable liveness signal: Canton answers it with the domain parameters
	// as soon as the participant is connected to the domain.
	g.conn.Connect()
	stream, err := g.cfgSvc.GetLedgerConfiguration(ctx, &lapiv1.GetLedgerConfigurationRequest{
		LedgerId: g.cfg.LedgerID,
	})
	if err != nil {
		return fmt.Errorf("canton: Health: %w", classifyGRPC(err))
	}
	// Read one message and close — we just need a server-side ack.
	if _, err := stream.Recv(); err != nil {
		return fmt.Errorf("canton: Health: recv: %w", classifyGRPC(err))
	}
	return nil
}

// AllocateParty wraps PartyManagementService.AllocateParty. Per LAPI
// semantics, re-allocating the same hint is idempotent and returns the
// existing party id.
func (g *grpcTransport) AllocateParty(ctx context.Context, hint string) (string, error) {
	resp, err := g.party.AllocateParty(ctx, &lapiadmin.AllocatePartyRequest{
		PartyIdHint: hint,
	})
	if err != nil {
		return "", fmt.Errorf("canton: AllocateParty(%s): %w", hint, classifyGRPC(err))
	}
	pd := resp.GetPartyDetails()
	if pd == nil || pd.GetParty() == "" {
		return "", fmt.Errorf("canton: AllocateParty(%s): empty party id in response", hint)
	}
	return pd.GetParty(), nil
}

// ReadMaxDeduplicationDuration consumes one message from
// LedgerConfigurationService.GetLedgerConfiguration and returns the
// participant-advertised max_deduplication_duration. Canton's stream emits
// the current value immediately on subscription, so we read once and close.
func (g *grpcTransport) ReadMaxDeduplicationDuration(ctx context.Context) (time.Duration, error) {
	stream, err := g.cfgSvc.GetLedgerConfiguration(ctx, &lapiv1.GetLedgerConfigurationRequest{
		LedgerId: g.cfg.LedgerID,
	})
	if err != nil {
		// Some participant builds (and any LAPI implementation that does
		// not expose this stream) will fail with Unimplemented. The
		// canton package treats that as "fall back to the configured
		// ceiling".
		if codeOf(err) == codes.Unimplemented {
			return 0, ErrMaxDedupUnknown
		}
		return 0, fmt.Errorf("canton: GetLedgerConfiguration: %w", classifyGRPC(err))
	}
	resp, err := stream.Recv()
	if err != nil {
		return 0, fmt.Errorf("canton: GetLedgerConfiguration recv: %w", classifyGRPC(err))
	}
	cfg := resp.GetLedgerConfiguration()
	if cfg == nil || cfg.GetMaxDeduplicationDuration() == nil {
		return 0, ErrMaxDedupUnknown
	}
	return cfg.GetMaxDeduplicationDuration().AsDuration(), nil
}

// Close terminates the gRPC connection. Idempotent.
func (g *grpcTransport) Close() error {
	if g.conn == nil {
		return nil
	}
	err := g.conn.Close()
	g.conn = nil
	return err
}

// ---- helpers ------------------------------------------------------------

// buildCommand translates one Command (the package's transport-agnostic
// shape) into a v1 protobuf Command. Only "createAndExercise" is supported
// today — the package only emits that one Kind.
func buildCommand(c Command) (*lapiv1.Command, error) {
	if c.Kind != "createAndExercise" {
		return nil, fmt.Errorf("unsupported command kind %q", c.Kind)
	}
	tid, err := parseTemplateID(c.TemplateID)
	if err != nil {
		return nil, err
	}
	createRecord, err := mapToRecord(c.CreateArguments)
	if err != nil {
		return nil, fmt.Errorf("create_arguments: %w", err)
	}
	choiceVal, err := mapToValueRecord(c.ChoiceArguments)
	if err != nil {
		return nil, fmt.Errorf("choice_argument: %w", err)
	}
	return &lapiv1.Command{
		Command: &lapiv1.Command_CreateAndExercise{
			CreateAndExercise: &lapiv1.CreateAndExerciseCommand{
				TemplateId:      tid,
				CreateArguments: createRecord,
				Choice:          c.Choice,
				ChoiceArgument:  choiceVal,
			},
		},
	}, nil
}

// parseTemplateID accepts "Module:Entity" (package id resolved server-side
// via name lookup) or "PackageId:Module:Entity". Daml 2.x participants
// require a non-empty package_id in most submissions; operators that rely on
// the two-form variant must enable Canton's package-name resolution.
func parseTemplateID(s string) (*lapiv1.Identifier, error) {
	parts := strings.Split(s, ":")
	switch len(parts) {
	case 2:
		return &lapiv1.Identifier{
			ModuleName: parts[0],
			EntityName: parts[1],
		}, nil
	case 3:
		return &lapiv1.Identifier{
			PackageId:  parts[0],
			ModuleName: parts[1],
			EntityName: parts[2],
		}, nil
	default:
		return nil, fmt.Errorf("template id %q: want Module:Entity or PackageId:Module:Entity", s)
	}
}

// mapToRecord converts a Go map[string]any into a Daml LAPI Record. Field
// order is taken from the map iteration; the Daml server accepts unordered
// fields when every key is present (and our commands.go always supplies
// every field).
func mapToRecord(m map[string]any) (*lapiv1.Record, error) {
	if m == nil {
		return &lapiv1.Record{}, nil
	}
	fields := make([]*lapiv1.RecordField, 0, len(m))
	for k, v := range m {
		val, err := goToValue(v)
		if err != nil {
			return nil, fmt.Errorf("field %q: %w", k, err)
		}
		fields = append(fields, &lapiv1.RecordField{Label: k, Value: val})
	}
	return &lapiv1.Record{Fields: fields}, nil
}

// mapToValueRecord wraps mapToRecord in a Value{Record:...} so the result is
// usable as a choice_argument (which is typed Value, not Record).
func mapToValueRecord(m map[string]any) (*lapiv1.Value, error) {
	rec, err := mapToRecord(m)
	if err != nil {
		return nil, err
	}
	return &lapiv1.Value{Sum: &lapiv1.Value_Record{Record: rec}}, nil
}

// goToValue turns a primitive Go value into a Daml LAPI Value. The set of
// types is limited to what command.go emits today: string (Party / Text /
// ContractId — they share the wire form Text in our submissions; the Daml
// type-checker pinpoints which is wrong on the participant), int64 (Daml
// Int), and bool. The PaymentRequest createArguments use string + int64;
// the Pay choice uses a single string (sourceHolding contract id).
//
// String values are emitted as Text by default. The Daml type-checker
// converts Text → Party / ContractId / Numeric where the field type
// requires it; for fields whose Daml type is one of these the participant
// returns INVALID_ARGUMENT and the operator must use a stricter mapper.
func goToValue(v any) (*lapiv1.Value, error) {
	switch x := v.(type) {
	case nil:
		return &lapiv1.Value{Sum: &lapiv1.Value_Optional{Optional: &lapiv1.Optional{}}}, nil
	case Party:
		return &lapiv1.Value{Sum: &lapiv1.Value_Party{Party: string(x)}}, nil
	case ContractIDValue:
		return &lapiv1.Value{Sum: &lapiv1.Value_ContractId{ContractId: string(x)}}, nil
	case Numeric:
		return &lapiv1.Value{Sum: &lapiv1.Value_Numeric{Numeric: string(x)}}, nil
	case string:
		return &lapiv1.Value{Sum: &lapiv1.Value_Text{Text: x}}, nil
	case bool:
		return &lapiv1.Value{Sum: &lapiv1.Value_Bool{Bool: x}}, nil
	case int:
		return &lapiv1.Value{Sum: &lapiv1.Value_Int64{Int64: int64(x)}}, nil
	case int32:
		return &lapiv1.Value{Sum: &lapiv1.Value_Int64{Int64: int64(x)}}, nil
	case int64:
		return &lapiv1.Value{Sum: &lapiv1.Value_Int64{Int64: x}}, nil
	default:
		return nil, fmt.Errorf("unsupported value type %T", v)
	}
}

// Party, ContractIDValue, Numeric are typed-string wrappers that let
// createArguments / choiceArguments distinguish Daml Party / ContractId /
// Numeric fields from plain Text. goToValue emits the corresponding LAPI
// Value variant for each. Without these, Canton 2.x rejects submissions
// with "mismatching type: Party and value: ValueText(...)".
type Party string
type ContractIDValue string
type Numeric string

// completionToEvent maps a v1 Completion + checkpoint offset into the
// package's CompletionEvent shape. Success vs failure is keyed off the gRPC
// status carried on the completion: code 0 (OK) or nil status → SUCCESS;
// anything else → FAILURE.
func completionToEvent(c *lapiv1.Completion, offset string) CompletionEvent {
	st := c.GetStatus()
	if st == nil || st.GetCode() == 0 {
		return CompletionEvent{
			CommandID: c.GetCommandId(),
			TxID:      c.GetTransactionId(),
			Status:    CompletionSuccess,
			Offset:    offset,
			Time:      time.Now().UTC(),
		}
	}
	return CompletionEvent{
		CommandID: c.GetCommandId(),
		Status:    CompletionFailure,
		Code:      codes.Code(st.GetCode()).String(),
		Message:   st.GetMessage(),
		Offset:    offset,
		Time:      time.Now().UTC(),
	}
}

// treeToDetails maps a TransactionTree into TransactionDetails. The receipt
// builder only needs the PaymentRequest contract id (from the Created
// event) and the merchant Holding contract id (from the descendant Created
// event under the Pay exercise); we surface every event so the builder can
// pick whatever it needs.
func treeToDetails(tree *lapiv1.TransactionTree, ledgerID string) TransactionDetails {
	out := TransactionDetails{
		TxID:     tree.GetTransactionId(),
		LedgerID: ledgerID,
		Offset:   tree.GetOffset(),
	}
	if eff := tree.GetEffectiveAt(); eff != nil {
		out.EffectiveAt = eff.AsTime()
	}
	for _, ev := range tree.GetEventsById() {
		switch k := ev.GetKind().(type) {
		case *lapiv1.TreeEvent_Created:
			ce := k.Created
			te := TransactionEvent{
				Kind:       "created",
				ContractID: ce.GetContractId(),
				TemplateID: identifierString(ce.GetTemplateId()),
			}
			out.Events = append(out.Events, te)
			// Heuristic: the first PaymentRequest:Payment template id is
			// the original create; subsequent Holding template id is the
			// merchant's new holding. The receipt builder downstream
			// performs the strict template matching; here we just
			// populate the convenience fields.
			tmpl := strings.ToLower(te.TemplateID)
			switch {
			case out.PaymentRequestContractID == "" && strings.Contains(tmpl, "paymentrequest"):
				out.PaymentRequestContractID = te.ContractID
			case strings.Contains(tmpl, "holding"):
				out.HoldingContractID = te.ContractID
			}
		case *lapiv1.TreeEvent_Exercised:
			xe := k.Exercised
			te := TransactionEvent{
				Kind:       "exercised",
				ContractID: xe.GetContractId(),
				TemplateID: identifierString(xe.GetTemplateId()),
			}
			out.Events = append(out.Events, te)
		}
	}
	return out
}

func identifierString(id *lapiv1.Identifier) string {
	if id == nil {
		return ""
	}
	return id.GetPackageId() + ":" + id.GetModuleName() + ":" + id.GetEntityName()
}

// classifyGRPC turns a gRPC error into one of the package's typed sentinels
// when the code matches the §6.2 error map. Unrecognised errors pass
// through unchanged.
func classifyGRPC(err error) error {
	if err == nil {
		return nil
	}
	switch codeOf(err) {
	case codes.InvalidArgument:
		return &InvalidInputError{Cause: err}
	default:
		return err
	}
}

func codeOf(err error) codes.Code {
	st, ok := status.FromError(err)
	if !ok {
		var ce interface{ GRPCStatus() *status.Status }
		if errors.As(err, &ce) {
			return ce.GRPCStatus().Code()
		}
		return codes.Unknown
	}
	return st.Code()
}

func durationOr(d, fallback time.Duration) time.Duration {
	if d <= 0 {
		return fallback
	}
	return d
}
