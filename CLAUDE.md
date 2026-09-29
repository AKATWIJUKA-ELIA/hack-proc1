please read and understand the the existing code base before you do any edits.


<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

TASK

What this project is all about

This is a convex backed project that makes procurement workflows easy with AI.
--- user workflow ---

Thee app provides the user an interface to wask for the items they want to buy, then the app takes those items and uses 
Firecrawl to search for the available sellers of the given items on the internet and different e-market place platforms,
Open AI sorts out that information and Identifies their emails and returns them and any relevant information, and also drafts emails asking for quotations from those sellers, then we use Agentmail to send the emails and get responses from them 
you are a senior software Engineer with Experience in full stack software developmet.

example
user types:
i want 50 × Dell Latitude 5550, i7/16GB/512GB, 
delivered to Kampala within 14 days
budget UGX 180,000,000 

then the workflow begins.
i have attached a picture of the current home page here /hack-proc/image.png


Your task is to 
migrate this project to a Next.Js full stack project while maintaining convex as the backend 

This current project runs on the convex site url  https://admired-partridge-220.convex.site/ and 
the convex backend is in the /convex folder.


you are required to give the new appliaction a nice and appealing UI with the best UI tools like shadcn and make it user friendly so that any procurement officer can use it.

At the end give me a report of what you did explaining each step you took to the finishing point


![alt text](image.png)