import {
	handleLiveEventsRequest,
	handleLiveStartRequest,
	handleLiveStopRequest,
} from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	return handleLiveStartRequest(id, request);
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	return handleLiveEventsRequest(id, request);
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	return handleLiveStopRequest(id, request);
}
