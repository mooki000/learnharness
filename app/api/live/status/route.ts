import { liveAvailabilityResponse } from "@/src/server";

export async function GET() {
	return liveAvailabilityResponse();
}
