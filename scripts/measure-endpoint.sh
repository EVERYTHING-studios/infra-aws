#!/usr/bin/env bash
# Measure the billable time of a SageMaker async-inference endpoint run.
#
# Resolves a measurement window (from a task record or the last N hours), then
# pulls Application Auto Scaling activities (scale-up/scale-in = billable window)
# and CloudWatch metrics (cold start, inference GPU work, queue wait, cooldown)
# to produce a cost breakdown showing where billable time comes from.
#
# Inputs (env vars, all defaulted):
#   TASK_ID   optional ULID; sets the window to that task's created_at..finished_at
#   HOURS     window length when no TASK_ID (default 2)
#   ENV       deployment env (default staging) — selects the tasks table and,
#             when ENDPOINT is unset, the active_endpoint SSM parameter
#   ENDPOINT  SageMaker endpoint name. Default: the currently elected chain
#             endpoint (SSM /generate/<env>/sagemaker/active_endpoint) — set
#             explicitly to measure a non-active chain entry (e.g. the g6e
#             fallback or a -useast2 regional endpoint)
#   VARIANT   production-variant name (default trellis)
#   REGION    AWS region (default us-east-1)
#   RATE      $/hour for the instance type; if unset, the AWS Pricing API is
#             attempted and a warning printed if it cannot be parsed
#   AWS_PROFILE  standard aws-cli profile env var (optional)
#
# Usage:
#   TASK_ID=01M0PBN340610W1CJRMYC4EAMX bash scripts/measure-endpoint.sh
#   bash scripts/measure-endpoint.sh            # last 2 hours
set -euo pipefail

ENV="${ENV:-staging}"
ENDPOINT="${ENDPOINT:-}"
VARIANT="${VARIANT:-trellis}"
REGION="${REGION:-us-east-1}"
TASK_ID="${TASK_ID:-}"
HOURS="${HOURS:-2}"
AWS_PROFILE="${AWS_PROFILE:-}"
TABLE="${TABLE:-generate-${ENV}-tasks}"
RATE="${RATE:-}"

AWS="aws --region $REGION"
[ -n "$AWS_PROFILE" ] && AWS="$AWS --profile $AWS_PROFILE"

# Default endpoint: the currently elected chain endpoint (the sentinel
# flips this SSM value on capacity evidence). Explicit ENDPOINT overrides —
# needed to measure a non-active chain entry.
if [ -z "$ENDPOINT" ]; then
  ENDPOINT=$($AWS ssm get-parameter \
    --name "/generate/${ENV}/sagemaker/active_endpoint" \
    --query 'Parameter.Value' --output text)
fi

RID="endpoint/$ENDPOINT/variant/$VARIANT"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
iso_to_epoch() { date -u -d "$1" +%s; }
epoch_to_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------------------
# 1. Resolve the measurement window
# ---------------------------------------------------------------------------
now_epoch=$(date -u +%s)
if [ -n "$TASK_ID" ]; then
  item=$($AWS dynamodb get-item \
    --table-name "$TABLE" \
    --key "{\"pk\":{\"S\":\"TASK#$TASK_ID\"}}" \
    --output json)
  created_at=$(echo "$item" | jq -r '.Item.created_at.S // empty')
  finished_at=$(echo "$item" | jq -r '.Item.finished_at.S // empty')
  task_status=$(echo "$item" | jq -r '.Item.status.S // empty')
  if [ -z "$created_at" ]; then
    echo "ERROR: task $TASK_ID not found in $TABLE (no created_at)." >&2
    exit 1
  fi
  win_start_epoch=$(iso_to_epoch "$created_at")
  if [ -n "$finished_at" ]; then
    win_end_epoch=$(iso_to_epoch "$finished_at")
  else
    win_end_epoch=$now_epoch
    echo "WARN: task $TASK_ID has no finished_at; window ends at now." >&2
  fi
  task_wall_s=$((win_end_epoch - win_start_epoch))
  echo "Task:        $TASK_ID"
  echo "Status:      $task_status"
  echo "Created:     $created_at"
  echo "Finished:    ${finished_at:-<pending>}"
  echo "Wall-clock:  ${task_wall_s}s"
else
  win_start_epoch=$((now_epoch - HOURS * 3600))
  win_end_epoch=$now_epoch
  echo "Window:      last ${HOURS}h ($(epoch_to_iso $win_start_epoch) .. $(epoch_to_iso $win_end_epoch))"
fi

# ---------------------------------------------------------------------------
# 2. Application Auto Scaling activities → billable window
# ---------------------------------------------------------------------------
activities=$($AWS application-autoscaling describe-scaling-activities \
  --service-namespace sagemaker \
  --resource-id "$RID" \
  --max-results 50 \
  --query 'ScalingActivities[?StatusCode==`Successful`]' \
  --output json)

# Filter to activities within the measurement window (StartTime >= win_start).
# Without this, max_by(.StartTime) can pick a scale-in from a prior cycle that
# ended before the current scale-up began, producing a negative billable window.
win_start_iso=$(epoch_to_iso $win_start_epoch)
scaling_source=""
activities_in_window=$(echo "$activities" | jq --arg ws "$win_start_iso" \
  '[.[] | select(.StartTime >= $ws)]')

scale_up_start=$(echo "$activities_in_window" | jq -r \
  '[.[] | select(.Cause | contains("scale-up"))] | max_by(.StartTime) | .StartTime // empty')
scale_up_end=$(echo "$activities_in_window" | jq -r \
  '[.[] | select(.Cause | contains("scale-up"))] | max_by(.StartTime) | .EndTime // empty')
scale_in_start=$(echo "$activities_in_window" | jq -r --arg su "$scale_up_start" \
  '[.[] | select(.Cause | contains("scale-down")) | select(.StartTime >= $su)] | max_by(.StartTime) | .StartTime // empty')
scale_in_end=$(echo "$activities_in_window" | jq -r --arg su "$scale_up_start" \
  '[.[] | select(.Cause | contains("scale-down")) | select(.StartTime >= $su)] | max_by(.StartTime) | .EndTime // empty')

if [ -z "$scale_up_start" ]; then
  # SageMaker async endpoints frequently scale WITHOUT AAS activity
  # records: native 0->1 provisioning on queued requests and alarm-driven
  # step-policy executions don't appear in describe-scaling-activities.
  # Fall back to async queue evidence: a HasBacklogWithoutCapacity
  # datapoint > 0 in the window means a request waited for capacity — a
  # true cold run even with no AAS activity.
  hbc_start=$($AWS cloudwatch get-metric-statistics \
    --namespace AWS/SageMaker \
    --metric-name HasBacklogWithoutCapacity \
    --dimensions Name=EndpointName,Value=$ENDPOINT \
    --start-time "$(epoch_to_iso $win_start_epoch)" \
    --end-time "$(epoch_to_iso $((win_end_epoch + 60)))" \
    --period 60 --statistics Maximum \
    --output json | jq -r \
    '[.Datapoints[] | select(.Maximum > 0)] | sort_by(.Timestamp) | .[0].Timestamp // empty')

  if [ -n "$hbc_start" ]; then
    scaling_source="async-queue"
    scale_up_start=$hbc_start
    su_start_epoch=$(iso_to_epoch "$scale_up_start")
    billable_start_epoch=$su_start_epoch
    echo ""
    echo "=== Scale-up (async native — no AAS activity records) ==="
    echo "  Capacity requested: $scale_up_start (HasBacklogWithoutCapacity)"

    # Scale-in evidence: the scale-to-zero alarm's action history records
    # the step-policy execution even when AAS activities don't. The
    # instance terminates a few minutes AFTER the action, so this end is a
    # floor (labeled as such in the report).
    alarm_name=$($AWS cloudwatch describe-alarms --output json \
      | jq -r --arg ep "$ENDPOINT" \
      '.MetricAlarms[] | select((.Dimensions[]?.Value) == $ep and .MetricName == "EndpointIdle") | .AlarmName' \
      | head -1)
    scale_down_action=""
    if [ -n "$alarm_name" ]; then
      scale_down_action=$($AWS cloudwatch describe-alarm-history \
        --alarm-name "$alarm_name" \
        --history-item-type Action \
        --start-date "$win_start_iso" \
        --output json | jq -r --arg su "$scale_up_start" \
        '[.AlarmHistoryItems[] | select(.Timestamp >= $su)
          | select(.HistorySummary | contains("Successfully executed action") and contains("scale-down"))
          ] | max_by(.Timestamp) | .Timestamp // empty')
    fi
    if [ -n "$scale_down_action" ]; then
      scale_in_start=$scale_down_action
      scale_in_end=$scale_down_action
      billable_end_epoch=$(iso_to_epoch "$scale_down_action")
      echo ""
      echo "=== Scale-in (alarm action; termination follows within minutes) ==="
      echo "  Scale-down executed: $scale_down_action"
    else
      billable_end_epoch=$now_epoch
      echo ""
      echo "WARN: no scale-down alarm action in window; billable-so-far = scale-up -> now."
      echo "      Re-run after scale-to-zero for the full billable window."
    fi
    billable_s=$((billable_end_epoch - billable_start_epoch))
    echo ""
    echo "Billable window (floor, excl. termination lag): $scale_up_start -> $(epoch_to_iso $billable_end_epoch) = ${billable_s}s"
    is_warm=0
  else
    echo ""
    echo "=== WARM RUN (no scale-up activity, no queued-without-capacity) ==="
    echo "The instance was already warm. No cold-start/cooldown breakdown —"
    echo "reporting inference only."
    is_warm=1
  fi
else
  is_warm=0
  su_start_epoch=$(iso_to_epoch "$scale_up_start")
  echo ""
  echo "=== Scale-up (provisioning begins) ==="
  echo "  Start: $scale_up_start"
  echo "  End:   $scale_up_end"
  if [ -z "$scale_in_end" ]; then
    billable_end_epoch=$now_epoch
    echo ""
    echo "WARN: no completed scale-in yet (instance still warm)."
    echo "      Billable-so-far = scale-up start -> now."
    echo "      Re-run after scale-to-zero for the full billable window."
  else
    si_end_epoch=$(iso_to_epoch "$scale_in_end")
    billable_end_epoch=$si_end_epoch
    echo ""
    echo "=== Scale-in (instance terminated) ==="
    echo "  Start: $scale_in_start"
    echo "  End:   $scale_in_end"
  fi
  billable_start_epoch=$su_start_epoch
  billable_s=$((billable_end_epoch - billable_start_epoch))
  echo ""
  echo "Billable window: $scale_up_start -> $(epoch_to_iso $billable_end_epoch) = ${billable_s}s"
fi

# ---------------------------------------------------------------------------
# 3. CloudWatch metrics over the window
# ---------------------------------------------------------------------------
cw_start=$(epoch_to_iso $win_start_epoch)
# Extend the metric query end by one period: CloudWatch excludes datapoints
# whose period boundary hasn't been reached by --end-time (a datapoint at
# 16:17:00 with period 60 needs end-time >= 16:18:00 to be returned).
cw_end=$(epoch_to_iso $((win_end_epoch + 60)))
period=60

get_metric() {
  local metric=$1 stat=$2 dims=$3
  $AWS cloudwatch get-metric-statistics \
    --namespace AWS/SageMaker \
    --metric-name "$metric" \
    --dimensions $dims \
    --start-time "$cw_start" \
    --end-time "$cw_end" \
    --period "$period" \
    --statistics "$stat" \
    --output json
}

dim_ep="Name=EndpointName,Value=$ENDPOINT"
dim_var="Name=EndpointName,Value=$ENDPOINT Name=VariantName,Value=$VARIANT"

# InvocationsProcessed (async endpoints report InvocationsProcessed, not Invocations)
invocations=$(get_metric InvocationsProcessed Sum "$dim_var")
first_invocation_ts=$(echo "$invocations" | jq -r \
  '[.Datapoints[] | select(.Sum > 0)] | sort_by(.Timestamp) | .[0].Timestamp // empty')
invocations_sum=$(echo "$invocations" | jq -r '[.Datapoints[].Sum] | add // 0')

# ModelLatency (microseconds of GPU work) / OverheadLatency (microseconds)
model_latency_us=$(get_metric ModelLatency Sum "$dim_var" \
  | jq -r '[.Datapoints[].Sum] | add // 0')
overhead_us=$(get_metric OverheadLatency Sum "$dim_var" \
  | jq -r '[.Datapoints[].Sum] | add // 0')

# Queue wait — ApproximateAgeOfOldestRequest (seconds, Maximum)
queue_wait_s=$(get_metric ApproximateAgeOfOldestRequest Maximum "$dim_ep" \
  | jq -r '[.Datapoints[].Maximum] | max // 0')

# Backlog-without-capacity minutes (Sum)
backlog_min=$(get_metric HasBacklogWithoutCapacity Sum "$dim_ep" \
  | jq -r '[.Datapoints[].Sum] | add // 0')

# GPU utilization / memory (Average)
gpu_util=$(get_metric GPUUtilization Average "$dim_var" \
  | jq -r '[.Datapoints[].Average] | add // 0 | if . == 0 then 0 else . / length end')
gpu_mem=$(get_metric GPUMemoryUsed Average "$dim_var" \
  | jq -r '[.Datapoints[].Average] | add // 0 | if . == 0 then 0 else . / length end')

inference_gpu_s=$(echo "$model_latency_us" | awk '{printf "%.3f", $1/1000000}')
overhead_s=$(echo "$overhead_us" | awk '{printf "%.3f", $1/1000000}')

echo ""
echo "=== CloudWatch metrics ($cw_start .. $cw_end) ==="
echo "  Invocations:                $invocations_sum"
echo "  First invocation served:    ${first_invocation_ts:-<none>}"
echo "  ModelLatency (GPU work):    ${inference_gpu_s}s"
echo "  OverheadLatency:            ${overhead_s}s"
echo "  Queue wait (oldest req):    ${queue_wait_s}s"
echo "  Backlog w/o capacity:       ${backlog_min} min"
echo "  GPU utilization (avg):      ${gpu_util}%"
echo "  GPU memory used (avg):      ${gpu_mem} MiB"

# ---------------------------------------------------------------------------
# 4. Report
# ---------------------------------------------------------------------------
echo ""
echo "================ MEASUREMENT REPORT ================"

if [ "$is_warm" = "1" ]; then
  echo "Run type:           WARM (instance already provisioned)"
  echo "Inference GPU work: ${inference_gpu_s}s"
  echo "Overhead:           ${overhead_s}s"
  if [ -n "$TASK_ID" ]; then
    echo "Task wall-clock:    ${task_wall_s}s ($task_status)"
  fi
  echo "---------------------------------------------------"
  echo "No cold-start or cooldown components (warm run)."
  echo "Submit after scale-to-zero for the full breakdown."
  echo "==================================================="
  exit 0
fi

# cold_start_s = first_invocation_ts - scale_up.start
if [ -n "$first_invocation_ts" ]; then
  first_inv_epoch=$(iso_to_epoch "$first_invocation_ts")
  cold_start_s=$((first_inv_epoch - billable_start_epoch))
else
  cold_start_s=0
  echo "WARN: no invocation datapoints — cold_start_s set to 0." >&2
fi

# cooldown_s = scale_in.end - last_invocation_ts
last_invocation_ts=$(echo "$invocations" | jq -r \
  '[.Datapoints[] | select(.Sum > 0)] | sort_by(.Timestamp) | .[-1].Timestamp // empty')
if [ -n "$last_invocation_ts" ] && [ -n "$scale_in_end" ]; then
  last_inv_epoch=$(iso_to_epoch "$last_invocation_ts")
  cooldown_s=$((billable_end_epoch - last_inv_epoch))
else
  cooldown_s=0
fi

if [ "$billable_s" -gt 0 ]; then
  idle_s=$((cold_start_s + cooldown_s))
  idle_fraction=$(awk -v i="$idle_s" -v b="$billable_s" 'BEGIN{printf "%.1f", (i/b)*100}')
else
  idle_fraction=0
fi

echo "Run type:           COLD (scale 0 -> 1)"
echo "Billable window:    ${billable_s}s  ($scale_up_start -> $(epoch_to_iso $billable_end_epoch))"
if [ "$scaling_source" = "async-queue" ]; then
  echo "  Note:             floor — add instance termination lag (~2-10 min) for the full cycle"
fi
echo "  Cold start:       ${cold_start_s}s  (provision + download + weights load)"
echo "  Inference GPU:    ${inference_gpu_s}s  (useful work)"
echo "  Overhead:         ${overhead_s}s"
echo "  Cooldown:         ${cooldown_s}s  (last invocation -> scale-in end)"
echo "  Idle fraction:    ${idle_fraction}%  (cold start + cooldown / billable)"
echo "  Queue wait:       ${queue_wait_s}s"
if [ -n "$TASK_ID" ]; then
  echo "Task wall-clock:    ${task_wall_s}s ($task_status)"
fi

# Estimated cost. INSTANCE_TYPE + AWS_DEFAULT_REGION select the pricing-API
# lookup; RATE overrides the lookup entirely. Default INSTANCE_TYPE is derived
# from the endpoint name token (g5/g6e/g7e), matching whatever endpoint is
# being measured.
INSTANCE_TYPE="${INSTANCE_TYPE:-}"
if [ -z "$INSTANCE_TYPE" ]; then
  token=$(echo "$ENDPOINT" | sed -E 's/-(useast2|uswest2)$//' | awk -F- '{print $NF}')
  case "$token" in
    g5)  INSTANCE_TYPE="ml.g5.2xlarge" ;;
    g6e) INSTANCE_TYPE="ml.g6e.2xlarge" ;;
    g7e) INSTANCE_TYPE="ml.g7e.2xlarge" ;;
    *)   echo "WARN: unrecognized endpoint token '$token'; set INSTANCE_TYPE or RATE for cost estimation." >&2 ;;
  esac
fi
if [ -z "$RATE" ]; then
  RATE=$($AWS pricing get-products \
    --service-code AmazonSageMaker \
    --filters "Type=TERM_MATCH,Field=instanceType,Value=${INSTANCE_TYPE}" \
              'Type=TERM_MATCH,Field=productfamily,Value=ML Instance' \
              "Type=TERM_MATCH,Field=regionCode,Value=${AWS_DEFAULT_REGION:-us-east-1}" \
    --max-results 1 \
    --query 'PriceList[0]' --output text 2>/dev/null \
    | jq -r '.terms.OnDemand | to_entries[0].value.priceDimensions | to_entries[0].value.pricePerUnit.USD // empty' 2>/dev/null || true)
  if [ -z "$RATE" ]; then
    echo ""
    echo "WARN: could not parse instance rate from AWS Pricing API."
    echo "      Set RATE=<usd-per-hour> to include est_cost_usd."
  else
    echo "  Hourly rate:      \$${RATE}/hr (AWS Pricing API)"
  fi
fi

if [ -n "$RATE" ] && [ "$billable_s" -gt 0 ]; then
  est_cost=$(awk -v s="$billable_s" -v r="$RATE" 'BEGIN{printf "%.4f", (s/3600)*r}')
  echo "  Est cost:         \$${est_cost}"
fi
echo "==================================================="
